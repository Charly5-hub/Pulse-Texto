(function setupPayGuard(global) {
  "use strict";

  if (!global) {
    return;
  }

  var config = global.SIMPLIFY_PAY_CONFIG || {};
  var storageKeys = config.storage || {};
  var monetization = config.monetization || {};

  var usageKey = storageKeys.usage || "simplify.usage.v1";
  var creditsKey = storageKeys.paidCredits || "simplify.paidCredits.v1";
  var bypassKey = storageKeys.adminBypass || "simplify.adminBypass.v1";
  var customerKey = storageKeys.customerId || "simplify.customerId.v1";
  var planTierKey = storageKeys.planTier || "simplify.planTier.v1";

  var freeUses = Number(config.freeUses || 3);
  var listeners = [];
  var syncInFlight = null;

  function safeGet(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function safeSet(key, value) {
    try {
      global.localStorage.setItem(key, String(value));
    } catch (error) {
      // Ignore storage write errors in private modes.
    }
  }

  function readInt(key, fallback) {
    var raw = safeGet(key);
    var num = raw === null ? NaN : Number(raw);
    return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : fallback;
  }

  function toNonEmptyString(value) {
    var normalized = typeof value === "string" ? value.trim() : "";
    return normalized || "";
  }

  function trimTrailingSlash(value) {
    return toNonEmptyString(value).replace(/\/+$/, "");
  }

  function getApiBase() {
    return trimTrailingSlash(monetization.apiBase || "");
  }

  function getPath(pathValue, fallback) {
    var candidate = toNonEmptyString(pathValue || "");
    return candidate || fallback;
  }

  function createCustomerId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return "cust_" + global.crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    }
    return "cust_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function getCustomerId() {
    if (global.SimplifyAuth && typeof global.SimplifyAuth.getCustomerId === "function") {
      var authCustomer = toNonEmptyString(global.SimplifyAuth.getCustomerId());
      if (authCustomer) {
        safeSet(customerKey, authCustomer);
        return authCustomer;
      }
    }
    var existing = toNonEmptyString(safeGet(customerKey));
    if (existing) {
      return existing;
    }
    var created = createCustomerId();
    safeSet(customerKey, created);
    return created;
  }

  function setCustomerId(value) {
    var normalized = toNonEmptyString(value);
    if (!normalized) {
      return;
    }
    safeSet(customerKey, normalized);
    if (global.SimplifyAuth && typeof global.SimplifyAuth.setCustomerId === "function") {
      global.SimplifyAuth.setCustomerId(normalized);
    }
  }

  function buildURL(pathValue) {
    var base = getApiBase();
    if (!base) {
      return "";
    }
    if (!pathValue) {
      return base;
    }
    if (pathValue.charAt(0) !== "/") {
      return base + "/" + pathValue;
    }
    return base + pathValue;
  }

  function notify() {
    var snapshot = api.getState();
    listeners.forEach(function (listener) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("[Simplify] Error en listener de créditos", error);
      }
    });
  }

  function getState() {
    var used = readInt(usageKey, 0);
    var paidCredits = readInt(creditsKey, 0);
    var bypass = safeGet(bypassKey) === "1";
    var freeLeft = Math.max(0, freeUses - used);
    var planTier = toNonEmptyString(safeGet(planTierKey)) || "free";

    return {
      customerId: getCustomerId(),
      freeUses: freeUses,
      freeUsed: used,
      freeLeft: freeLeft,
      paidCredits: paidCredits,
      planTier: planTier,
      bypass: bypass,
      available: bypass ? Number.POSITIVE_INFINITY : (freeLeft + paidCredits),
    };
  }

  function canUseRemoteBilling() {
    return Boolean(getApiBase());
  }

  function fetchJSON(url, options) {
    var requestOptions = Object.assign({}, options || {});
    requestOptions.headers = Object.assign({}, requestOptions.headers || {});
    if (global.SimplifyAuth && typeof global.SimplifyAuth.authHeaders === "function") {
      requestOptions.headers = global.SimplifyAuth.authHeaders(requestOptions.headers);
    }
    return fetch(url, requestOptions).then(function (response) {
      return response.text().then(function (text) {
        var json = null;
        if (text) {
          try {
            json = JSON.parse(text);
          } catch (error) {
            json = null;
          }
        }
        if (!response.ok) {
          var detail = json && (json.error || json.detail)
            ? (json.error || json.detail)
            : ("HTTP " + response.status);
          throw new Error(String(detail));
        }
        return json || {};
      });
    });
  }

  function syncRemoteBalance(force) {
    if (!canUseRemoteBilling()) {
      return Promise.resolve({ synced: false, reason: "api-base-missing" });
    }
    if (syncInFlight && !force) {
      return syncInFlight;
    }

    var balancePath = getPath(monetization.balancePath, "/api/pay/balance");
    var customerId = getCustomerId();
    var url = buildURL(balancePath) + "?customerId=" + encodeURIComponent(customerId);

    syncInFlight = fetchJSON(url, { method: "GET" })
      .then(function (payload) {
        var balance = payload && payload.balance ? payload.balance : payload;
        var credits = Number(balance && balance.credits);
        var remoteFreeUses = Number(balance && balance.freeUses);
        var remoteFreeUsed = Number(balance && balance.freeUsed);
        var remotePlanTier = toNonEmptyString(balance && balance.planTier);
        var remoteCustomer = toNonEmptyString(payload && payload.customerId);

        if (Number.isFinite(credits)) {
          safeSet(creditsKey, Math.max(0, Math.floor(credits)));
        }
        if (Number.isFinite(remoteFreeUses) && remoteFreeUses >= 0) {
          freeUses = Math.floor(remoteFreeUses);
        }
        if (Number.isFinite(remoteFreeUsed) && remoteFreeUsed >= 0) {
          safeSet(usageKey, Math.max(0, Math.floor(remoteFreeUsed)));
        }
        if (remotePlanTier) {
          safeSet(planTierKey, remotePlanTier);
        }
        if (remoteCustomer) {
          setCustomerId(remoteCustomer);
        }
        notify();
        return { synced: true, balance: getState() };
      })
      .catch(function (error) {
        return { synced: false, reason: error && error.message ? error.message : "sync-failed" };
      })
      .finally(function () {
        syncInFlight = null;
      });

    return syncInFlight;
  }

  function consumeRemoteCredit(units) {
    if (!canUseRemoteBilling()) {
      return Promise.resolve({ ok: false, reason: "api-base-missing" });
    }

    var consumePath = getPath(monetization.consumePath, "/api/pay/consume");
    var url = buildURL(consumePath);

    return fetchJSON(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId: getCustomerId(),
        units: units,
      }),
    }).then(function (payload) {
      var credits = Number(payload && payload.balance && payload.balance.credits);
      if (Number.isFinite(credits)) {
        safeSet(creditsKey, Math.max(0, Math.floor(credits)));
        notify();
      }
      return { ok: true };
    }).catch(function (error) {
      return syncRemoteBalance(true).then(function () {
        return { ok: false, reason: error && error.message ? error.message : "consume-failed" };
      });
    });
  }

  function trackEvent(eventName, payload) {
    if (!canUseRemoteBilling()) {
      return Promise.resolve({ ok: false, reason: "api-base-missing" });
    }
    if (!eventName || typeof eventName !== "string") {
      return Promise.resolve({ ok: false, reason: "event-name-missing" });
    }

    var eventPath = getPath(monetization.eventsPath, "/api/events/track");
    var url = buildURL(eventPath);

    return fetchJSON(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventName: eventName,
        customerId: getCustomerId(),
        payload: payload && typeof payload === "object" ? payload : {},
      }),
    }).then(function () {
      return { ok: true };
    }).catch(function (error) {
      return { ok: false, reason: error && error.message ? error.message : "event-failed" };
    });
  }

  var api = {
    getState: getState,
    getApiBase: getApiBase,
    getCustomerId: getCustomerId,
    setCustomerId: setCustomerId,
    canUseRemoteBilling: canUseRemoteBilling,
    canUse: function canUse() {
      var state = getState();
      return state.bypass || state.available > 0;
    },
    consumeUse: function consumeUse() {
      var state = getState();
      if (state.bypass) {
        notify();
        return true;
      }

      if (state.freeLeft > 0) {
        safeSet(usageKey, state.freeUsed + 1);
        notify();
        return true;
      }

      if (state.paidCredits > 0) {
        safeSet(creditsKey, state.paidCredits - 1);
        notify();
        consumeRemoteCredit(1);
        return true;
      }

      notify();
      return false;
    },
    addCredits: function addCredits(amount) {
      var current = getState().paidCredits;
      var next = current + Math.max(0, Number(amount) || 0);
      safeSet(creditsKey, next);
      notify();
    },
    setBypass: function setBypass(enabled) {
      safeSet(bypassKey, enabled ? "1" : "0");
      notify();
    },
    resetUsage: function resetUsage() {
      safeSet(usageKey, 0);
      safeSet(creditsKey, 0);
      safeSet(bypassKey, "0");
      notify();
    },
    syncRemoteBalance: syncRemoteBalance,
    consumeRemoteCredit: consumeRemoteCredit,
    trackEvent: trackEvent,
    onChange: function onChange(listener) {
      if (typeof listener !== "function") {
        return function noop() {};
      }
      listeners.push(listener);
      return function unsubscribe() {
        listeners = listeners.filter(function (item) {
          return item !== listener;
        });
      };
    },
  };

  global.SimplifyPayGuard = api;
})(window);
