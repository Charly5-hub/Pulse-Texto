(function setupPayGuard(global) {
  "use strict";

  if (!global) {
    return;
  }

  var config = global.SIMPLIFY_PAY_CONFIG || {};
  var storageKeys = (config.storage || {});
  var usageKey = storageKeys.usage || "simplify.usage.v1";
  var creditsKey = storageKeys.paidCredits || "simplify.paidCredits.v1";
  var bypassKey = storageKeys.adminBypass || "simplify.adminBypass.v1";
  var freeUses = Number(config.freeUses || 3);
  var listeners = [];

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

    return {
      freeUses: freeUses,
      freeUsed: used,
      freeLeft: freeLeft,
      paidCredits: paidCredits,
      bypass: bypass,
      available: bypass ? Number.POSITIVE_INFINITY : (freeLeft + paidCredits),
    };
  }

  var api = {
    getState: getState,
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
