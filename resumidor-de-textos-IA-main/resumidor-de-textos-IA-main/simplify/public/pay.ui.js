(function setupPayUI(global) {
  "use strict";

  function applyLink(element, value) {
    if (!element) {
      return;
    }

    var normalized = typeof value === "string" ? value.trim() : "";
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

    badge.textContent = String(state.freeLeft) + "/" + String(state.freeUses);
  }

  function initPayUI() {
    var config = global.SIMPLIFY_PAY_CONFIG || {};
    var links = config.links || {};

    applyLink(document.getElementById("pay-one"), links.one);
    applyLink(document.getElementById("pay-pack"), links.pack);
    applyLink(document.getElementById("pay-sub"), links.sub);

    if (global.SimplifyPayGuard) {
      updateUsageCounter(global.SimplifyPayGuard.getState());
      global.SimplifyPayGuard.onChange(updateUsageCounter);
    }
  }

  if (global.SimplifyApp && typeof global.SimplifyApp.registerInit === "function") {
    global.SimplifyApp.registerInit("pay-ui", initPayUI);
  } else {
    document.addEventListener("DOMContentLoaded", initPayUI, { once: true });
  }
})(window);
