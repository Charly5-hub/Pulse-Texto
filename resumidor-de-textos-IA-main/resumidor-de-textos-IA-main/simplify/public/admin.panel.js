(function setupAdminPanel(global) {
  "use strict";

  function toNonEmptyString(value) {
    var normalized = typeof value === "string" ? value.trim() : "";
    return normalized || "";
  }

  function trimTrailingSlash(value) {
    return toNonEmptyString(value).replace(/\/+$/, "");
  }

  function fetchJSON(url, options) {
    return fetch(url, options).then(function (response) {
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

  function initAdminPanel() {
    var config = global.SIMPLIFY_PAY_CONFIG || {};
    var monetization = config.monetization || {};
    var apiBase = trimTrailingSlash(monetization.apiBase || "");
    if (!apiBase) {
      return;
    }

    var panel = document.getElementById("admin-panel");
    var keyInput = document.getElementById("admin-api-key");
    var daysSelect = document.getElementById("admin-days");
    var metricsButton = document.getElementById("btn-admin-metrics");
    var reconcileButton = document.getElementById("btn-admin-reconcile");
    var grantButton = document.getElementById("btn-admin-grant");
    var targetCustomerInput = document.getElementById("admin-target-customer");
    var grantCreditsInput = document.getElementById("admin-grant-credits");
    var output = document.getElementById("admin-output");

    if (!panel || !metricsButton || !reconcileButton || !grantButton || !output) {
      return;
    }

    function shouldShowPanel() {
      var params = new URLSearchParams(global.location.search);
      if (params.get("admin") === "1") {
        return true;
      }
      var auth = global.SimplifyAuth && global.SimplifyAuth.getUser ? global.SimplifyAuth.getUser() : null;
      return Boolean(auth && auth.role === "admin");
    }

    function makeHeaders() {
      var headers = {
        "Content-Type": "application/json",
      };
      var key = keyInput ? toNonEmptyString(keyInput.value) : "";
      if (key) {
        headers["x-admin-key"] = key;
      }
      if (global.SimplifyAuth && typeof global.SimplifyAuth.authHeaders === "function") {
        headers = global.SimplifyAuth.authHeaders(headers);
      }
      return headers;
    }

    function setOutput(data) {
      output.textContent = JSON.stringify(data, null, 2);
    }

    function setBusy(button, isBusy) {
      button.disabled = isBusy;
      button.setAttribute("aria-disabled", isBusy ? "true" : "false");
    }

    function loadMetrics() {
      var days = daysSelect ? Number(daysSelect.value || 30) : 30;
      var path = toNonEmptyString(monetization.adminMetricsPath || "/api/admin/metrics");
      var url = apiBase + (path.charAt(0) === "/" ? path : "/" + path) + "?days=" + encodeURIComponent(days);
      setBusy(metricsButton, true);
      fetchJSON(url, {
        method: "GET",
        headers: makeHeaders(),
      }).then(setOutput).catch(function (error) {
        setOutput({ error: error && error.message ? error.message : "No se pudo cargar métricas." });
      }).finally(function () {
        setBusy(metricsButton, false);
      });
    }

    function reconcile() {
      var path = toNonEmptyString(monetization.adminReconcilePath || "/api/admin/reconcile/payments");
      var url = apiBase + (path.charAt(0) === "/" ? path : "/" + path);
      setBusy(reconcileButton, true);
      fetchJSON(url, {
        method: "POST",
        headers: makeHeaders(),
        body: JSON.stringify({ limit: 30 }),
      }).then(setOutput).catch(function (error) {
        setOutput({ error: error && error.message ? error.message : "No se pudo reconciliar." });
      }).finally(function () {
        setBusy(reconcileButton, false);
      });
    }

    function grantCredits() {
      var path = toNonEmptyString(monetization.adminGrantPath || "/api/admin/credits/grant");
      var url = apiBase + (path.charAt(0) === "/" ? path : "/" + path);
      var customerId = targetCustomerInput ? toNonEmptyString(targetCustomerInput.value) : "";
      var credits = grantCreditsInput ? Number(grantCreditsInput.value || 0) : 0;
      if (!customerId) {
        setOutput({ error: "Debes indicar customerId para acreditar." });
        return;
      }
      if (!Number.isFinite(credits) || credits <= 0) {
        setOutput({ error: "Debes indicar un número de créditos válido." });
        return;
      }

      setBusy(grantButton, true);
      fetchJSON(url, {
        method: "POST",
        headers: makeHeaders(),
        body: JSON.stringify({
          customerId: customerId,
          credits: Math.floor(credits),
        }),
      }).then(setOutput).catch(function (error) {
        setOutput({ error: error && error.message ? error.message : "No se pudieron acreditar créditos." });
      }).finally(function () {
        setBusy(grantButton, false);
      });
    }

    metricsButton.addEventListener("click", loadMetrics);
    reconcileButton.addEventListener("click", reconcile);
    grantButton.addEventListener("click", grantCredits);

    function applyVisibility() {
      panel.hidden = !shouldShowPanel();
    }

    applyVisibility();
    if (global.SimplifyAuth && typeof global.SimplifyAuth.onChange === "function") {
      global.SimplifyAuth.onChange(applyVisibility);
    }

    if (!panel.hidden) {
      if (targetCustomerInput && !targetCustomerInput.value && global.SimplifyAuth && typeof global.SimplifyAuth.getCustomerId === "function") {
        targetCustomerInput.value = toNonEmptyString(global.SimplifyAuth.getCustomerId());
      }
      loadMetrics();
    }
  }

  if (global.SimplifyApp && typeof global.SimplifyApp.registerInit === "function") {
    global.SimplifyApp.registerInit("admin-panel", initAdminPanel);
  } else {
    document.addEventListener("DOMContentLoaded", initAdminPanel, { once: true });
  }
})(window);
