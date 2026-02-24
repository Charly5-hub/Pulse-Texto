(function setupPayUI(global) {
  "use strict";

  function toNonEmptyString(value) {
    var normalized = typeof value === "string" ? value.trim() : "";
    return normalized || "";
  }

  function applyLink(element, value) {
    if (!element) {
      return;
    }

    var normalized = toNonEmptyString(value);
    if (!normalized || normalized === "#") {
      element.setAttribute("href", "#");
      element.setAttribute("aria-disabled", "true");
      return;
    }

    element.setAttribute("href", normalized);
    element.removeAttribute("aria-disabled");
  }

  function updateUsageCounter(state) {
    var badge = document.getElementById("uses-left");
    if (!badge || !state) {
      return;
    }
    var tierSuffix = state.planTier ? (" · plan " + state.planTier) : "";

    if (state.bypass) {
      badge.textContent = "∞" + tierSuffix;
      return;
    }

    if (state.paidCredits > 0) {
      badge.textContent = String(state.freeLeft) + "/" + String(state.freeUses) + " + " + String(state.paidCredits) + " créditos" + tierSuffix;
      return;
    }

    badge.textContent = String(state.freeLeft) + "/" + String(state.freeUses) + tierSuffix;
  }

  function findOrCreateStatusNode() {
    var current = document.getElementById("pay-status");
    if (current) {
      return current;
    }
    var payPanel = document.getElementById("pay-panel");
    if (!payPanel) {
      return null;
    }
    var node = document.createElement("small");
    node.id = "pay-status";
    node.className = "subtle";
    node.setAttribute("aria-live", "polite");
    payPanel.appendChild(node);
    return node;
  }

  function setStatus(message) {
    var node = findOrCreateStatusNode();
    if (!node) {
      return;
    }
    node.textContent = message || "";
  }

  function setButtonBusy(button, isBusy) {
    if (!button) {
      return;
    }
    button.dataset.busy = isBusy ? "1" : "0";
    if (isBusy) {
      button.setAttribute("aria-disabled", "true");
    } else {
      button.removeAttribute("aria-disabled");
    }
  }

  function safeGet(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (_error) {
      return "";
    }
  }

  function safeSet(key, value) {
    try {
      global.localStorage.setItem(key, value);
    } catch (_error) {
      // Ignore storage write failures.
    }
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

  function parseCheckoutStatusFromURL() {
    var params = new URLSearchParams(global.location.search);
    var status = params.get("checkout");
    if (!status) {
      return "";
    }
    return status.toLowerCase();
  }

  function parseCheckoutSessionIdFromURL() {
    var params = new URLSearchParams(global.location.search);
    return toNonEmptyString(params.get("session_id"));
  }

  function setupRemoteBilling(guard, config) {
    if (!guard || !guard.canUseRemoteBilling()) {
      return;
    }

    var monetization = config.monetization || {};
    var storage = config.storage || {};
    var legal = config.legal || {};
    var apiBase = guard.getApiBase();
    var checkoutPath = toNonEmptyString(monetization.checkoutPath || "/api/pay/checkout");
    var plansPath = toNonEmptyString(monetization.plansPath || "/api/pay/plans");
    var checkoutStatusPath = toNonEmptyString(monetization.checkoutStatusPath || "/api/pay/checkout-status");
    var legalConsentPath = toNonEmptyString(legal.consentPath || "/api/legal/consent");
    var legalConsentStatusPath = toNonEmptyString(legal.consentStatusPath || "/api/legal/consent-status");
    var legalVersion = toNonEmptyString(legal.currentVersion || "2026-02");
    var legalRequireForCheckout = legal.requireForCheckout !== false;
    var legalConsentVersionKey = toNonEmptyString(storage.legalConsentVersion || "simplify.legalConsentVersion.v1");
    var acquisitionChannelKey = toNonEmptyString(storage.acquisitionChannel || "simplify.acquisitionChannel.v1");

    var oneButton = document.getElementById("pay-one");
    var packButton = document.getElementById("pay-pack");
    var subButton = document.getElementById("pay-sub");
    var legalCheckbox = document.getElementById("legal-consent");
    var legalStatusNode = document.getElementById("legal-status");

    function setLegalStatus(message) {
      if (!legalStatusNode) {
        return;
      }
      legalStatusNode.textContent = message || "";
    }

    function hasLocalLegalConsent() {
      return safeGet(legalConsentVersionKey) === legalVersion;
    }

    function markLocalLegalConsent(version) {
      var targetVersion = toNonEmptyString(version || legalVersion);
      if (!targetVersion) {
        return;
      }
      safeSet(legalConsentVersionKey, targetVersion);
    }

    function getLegalPayloadSource() {
      return "pay-ui-checkout";
    }

    function normalizeChannel(value) {
      return toNonEmptyString(value)
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "")
        .slice(0, 40);
    }

    function inferReferrerChannel() {
      var ref = toNonEmptyString(global.document && global.document.referrer);
      if (!ref) {
        return "direct";
      }
      try {
        var refURL = new URL(ref);
        if (refURL.origin === global.location.origin) {
          return "direct";
        }
      } catch (_error) {
        // Ignore parse errors and fallback.
      }
      return "referral";
    }

    function getAcquisitionChannel() {
      var params = new URLSearchParams(global.location.search);
      var fromURL = normalizeChannel(params.get("utm_source") || params.get("channel") || "");
      if (fromURL) {
        safeSet(acquisitionChannelKey, fromURL);
        return fromURL;
      }
      var stored = normalizeChannel(safeGet(acquisitionChannelKey));
      if (stored) {
        return stored;
      }
      var inferred = inferReferrerChannel();
      safeSet(acquisitionChannelKey, inferred);
      return inferred;
    }

    function track(eventName, payload) {
      guard.trackEvent(eventName, payload || {});
    }

    function loadPlanLabels() {
      var plansURL = apiBase + (plansPath.charAt(0) === "/" ? plansPath : "/" + plansPath);
      fetchJSON(plansURL, { method: "GET" }).then(function (payload) {
        var plans = payload && payload.plans ? payload.plans : {};
        if (plans.one && oneButton) {
          oneButton.textContent = String(plans.one.credits) + " uso · " + formatAmount(plans.one);
        }
        if (plans.pack && packButton) {
          packButton.textContent = String(plans.pack.credits) + " usos · " + formatAmount(plans.pack);
        }
        if (plans.sub && subButton) {
          subButton.textContent = "Suscripción · " + formatAmount(plans.sub) + "/mes";
        }
      }).catch(function () {
        // Keep static labels on failure.
      });
    }

    function formatAmount(plan) {
      var amount = Number(plan && plan.amountCents);
      var currency = toNonEmptyString(plan && plan.currency || "eur").toUpperCase();
      if (!Number.isFinite(amount)) {
        return "N/D";
      }
      return (amount / 100).toLocaleString("es-ES", { style: "currency", currency: currency });
    }

    function syncLegalConsentStatus() {
      if (!legalRequireForCheckout || !legalConsentStatusPath) {
        return Promise.resolve({ ok: true, accepted: false });
      }
      var statusURL = apiBase + (legalConsentStatusPath.charAt(0) === "/" ? legalConsentStatusPath : "/" + legalConsentStatusPath)
        + "?customerId=" + encodeURIComponent(guard.getCustomerId())
        + "&version=" + encodeURIComponent(legalVersion);

      return fetchJSON(statusURL, { method: "GET" }).then(function (payload) {
        var accepted = Boolean(payload && payload.accepted);
        if (accepted) {
          markLocalLegalConsent(payload && payload.version ? payload.version : legalVersion);
          if (legalCheckbox) {
            legalCheckbox.checked = true;
          }
          setLegalStatus("Consentimiento legal activo (" + legalVersion + ").");
        } else if (legalCheckbox && !legalCheckbox.checked) {
          setLegalStatus("Para pagar, marca la aceptación de términos y privacidad.");
        }
        return { ok: true, accepted: accepted };
      }).catch(function () {
        if (hasLocalLegalConsent()) {
          if (legalCheckbox) {
            legalCheckbox.checked = true;
          }
          return { ok: true, accepted: true, local: true };
        }
        return { ok: false, accepted: false };
      });
    }

    function ensureLegalConsent() {
      if (!legalRequireForCheckout) {
        return Promise.resolve({ ok: true, skipped: true });
      }
      if (!legalCheckbox) {
        if (hasLocalLegalConsent()) {
          return Promise.resolve({ ok: true, local: true });
        }
        return Promise.reject(new Error("Falta aceptación legal para continuar con el pago."));
      }

      if (!legalCheckbox.checked && !hasLocalLegalConsent()) {
        return Promise.reject(new Error("Debes aceptar Términos y Privacidad para continuar."));
      }

      if (!legalCheckbox.checked && hasLocalLegalConsent()) {
        return Promise.resolve({ ok: true, local: true });
      }

      if (!legalConsentPath) {
        markLocalLegalConsent(legalVersion);
        return Promise.resolve({ ok: true, localOnly: true });
      }

      var consentURL = apiBase + (legalConsentPath.charAt(0) === "/" ? legalConsentPath : "/" + legalConsentPath);
      return fetchJSON(consentURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accepted: true,
          version: legalVersion,
          source: getLegalPayloadSource(),
          customerId: guard.getCustomerId(),
        }),
      }).then(function (payload) {
        markLocalLegalConsent(payload && payload.version ? payload.version : legalVersion);
        setLegalStatus("Consentimiento registrado correctamente.");
        return { ok: true };
      });
    }

    function reconcileCheckoutReturn(sessionId) {
      if (!sessionId || !checkoutStatusPath) {
        return guard.syncRemoteBalance(true).then(function () {
          setStatus("Créditos actualizados. ¡Listo para seguir!");
        });
      }
      var checkoutStatusURL = apiBase + (checkoutStatusPath.charAt(0) === "/" ? checkoutStatusPath : "/" + checkoutStatusPath)
        + "?sessionId=" + encodeURIComponent(sessionId)
        + "&customerId=" + encodeURIComponent(guard.getCustomerId());

      return fetchJSON(checkoutStatusURL, { method: "GET" }).then(function (payload) {
        var status = toNonEmptyString(payload && payload.status).toLowerCase();
        if (status === "completed" || status === "reconciled") {
          return guard.syncRemoteBalance(true).then(function () {
            setStatus("Pago confirmado y conciliado. Créditos actualizados.");
          });
        }
        return guard.syncRemoteBalance(true).then(function () {
          setStatus("Pago recibido. Reconciliación en curso, saldo sincronizado.");
        });
      }).catch(function () {
        return guard.syncRemoteBalance(true).then(function () {
          setStatus("Pago confirmado. Créditos actualizados (modo fallback).");
        });
      });
    }

    function beginCheckout(planId, button) {
      var checkoutURL = apiBase + (checkoutPath.charAt(0) === "/" ? checkoutPath : "/" + checkoutPath);
      var acquisitionChannel = getAcquisitionChannel();
      setButtonBusy(button, true);
      setStatus("Validando consentimiento legal…");
      track("checkout_started", { plan: planId, acquisitionChannel: acquisitionChannel });

      ensureLegalConsent().then(function () {
        setStatus("Preparando checkout seguro…");
        return fetchJSON(checkoutURL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plan: planId,
            customerId: guard.getCustomerId(),
            legalVersion: legalVersion,
            acceptLegal: Boolean(legalCheckbox && legalCheckbox.checked),
            acquisitionChannel: acquisitionChannel,
          }),
        });
      }).then(function (payload) {
        var redirect = toNonEmptyString(payload && payload.checkoutUrl);
        if (!redirect) {
          throw new Error("No se recibió URL de checkout.");
        }
        if (payload && payload.customerId && typeof guard.setCustomerId === "function") {
          guard.setCustomerId(payload.customerId);
        }
        track("checkout_redirected", { plan: planId, sessionId: payload.sessionId || "" });
        global.location.href = redirect;
      }).catch(function (error) {
        setStatus("No se pudo abrir el pago: " + (error && error.message ? error.message : "error inesperado"));
        if (/t[eé]rminos|privacidad|consentimiento/i.test(String(error && error.message || ""))) {
          track("checkout_blocked_legal", { plan: planId });
        }
        track("checkout_failed", { plan: planId, reason: error && error.message ? error.message : "unknown" });
      }).finally(function () {
        setButtonBusy(button, false);
      });
    }

    function wireButton(button, planId) {
      if (!button) {
        return;
      }
      button.setAttribute("href", "#");
      button.removeAttribute("aria-disabled");
      button.addEventListener("click", function (event) {
        event.preventDefault();
        if (button.dataset.busy === "1") {
          return;
        }
        beginCheckout(planId, button);
      });
    }

    wireButton(oneButton, "one");
    wireButton(packButton, "pack");
    wireButton(subButton, "sub");
    loadPlanLabels();

    if (legalCheckbox && hasLocalLegalConsent()) {
      legalCheckbox.checked = true;
      setLegalStatus("Consentimiento legal recordado para esta versión.");
    }
    if (legalCheckbox) {
      legalCheckbox.addEventListener("change", function () {
        if (!legalCheckbox.checked) {
          setLegalStatus("Recuerda aceptar los términos para completar pagos.");
          return;
        }
        ensureLegalConsent().catch(function () {
          setLegalStatus("No se pudo registrar el consentimiento ahora. Se reintentará al pagar.");
        });
      });
    }

    guard.syncRemoteBalance(true).then(function (result) {
      if (result && result.synced) {
        setStatus("Saldo sincronizado con servidor.");
      }
    });
    syncLegalConsentStatus();

    var checkoutStatus = parseCheckoutStatusFromURL();
    var checkoutSessionId = parseCheckoutSessionIdFromURL();
    if (checkoutStatus === "success") {
      setStatus("Pago confirmado. Sincronizando créditos…");
      track("checkout_success_return", { sessionId: checkoutSessionId || "" });
      reconcileCheckoutReturn(checkoutSessionId);
    } else if (checkoutStatus === "cancel") {
      setStatus("Pago cancelado. Puedes reintentar cuando quieras.");
      track("checkout_cancel_return", {});
    }
  }

  function initPayUI() {
    var config = global.SIMPLIFY_PAY_CONFIG || {};
    var links = config.links || {};

    applyLink(document.getElementById("pay-one"), links.one);
    applyLink(document.getElementById("pay-pack"), links.pack);
    applyLink(document.getElementById("pay-sub"), links.sub);

    var guard = global.SimplifyPayGuard;
    if (!guard) {
      return;
    }

    updateUsageCounter(guard.getState());
    guard.onChange(updateUsageCounter);
    setupRemoteBilling(guard, config);

    if (global.SimplifyAuth && typeof global.SimplifyAuth.onChange === "function") {
      global.SimplifyAuth.onChange(function () {
        guard.syncRemoteBalance(true);
        syncLegalConsentStatus();
      });
    }
  }

  if (global.SimplifyApp && typeof global.SimplifyApp.registerInit === "function") {
    global.SimplifyApp.registerInit("pay-ui", initPayUI);
  } else {
    document.addEventListener("DOMContentLoaded", initPayUI, { once: true });
  }
})(window);
