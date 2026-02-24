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

    if (state.bypass) {
      badge.textContent = "∞";
      return;
    }

    if (state.paidCredits > 0) {
      badge.textContent = String(state.freeLeft) + "/" + String(state.freeUses) + " + " + String(state.paidCredits) + " créditos";
      return;
    }

    badge.textContent = String(state.freeLeft) + "/" + String(state.freeUses);
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

  function setupRemoteBilling(guard, config) {
    if (!guard || !guard.canUseRemoteBilling()) {
      return;
    }

    var monetization = config.monetization || {};
    var apiBase = guard.getApiBase();
    var checkoutPath = toNonEmptyString(monetization.checkoutPath || "/api/pay/checkout");
    var plansPath = toNonEmptyString(monetization.plansPath || "/api/pay/plans");

    var oneButton = document.getElementById("pay-one");
    var packButton = document.getElementById("pay-pack");
    var subButton = document.getElementById("pay-sub");

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

    function beginCheckout(planId, button) {
      var checkoutURL = apiBase + (checkoutPath.charAt(0) === "/" ? checkoutPath : "/" + checkoutPath);
      setButtonBusy(button, true);
      setStatus("Preparando checkout seguro…");
      track("checkout_started", { plan: planId });

      fetchJSON(checkoutURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: planId,
          customerId: guard.getCustomerId(),
        }),
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

    guard.syncRemoteBalance(true).then(function (result) {
      if (result && result.synced) {
        setStatus("Saldo sincronizado con servidor.");
      }
    });

    var checkoutStatus = parseCheckoutStatusFromURL();
    if (checkoutStatus === "success") {
      setStatus("Pago confirmado. Sincronizando créditos…");
      track("checkout_success_return", {});
      guard.syncRemoteBalance(true).then(function () {
        setStatus("Créditos actualizados. ¡Listo para seguir!");
      });
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
      });
    }
  }

  if (global.SimplifyApp && typeof global.SimplifyApp.registerInit === "function") {
    global.SimplifyApp.registerInit("pay-ui", initPayUI);
  } else {
    document.addEventListener("DOMContentLoaded", initPayUI, { once: true });
  }
})(window);
