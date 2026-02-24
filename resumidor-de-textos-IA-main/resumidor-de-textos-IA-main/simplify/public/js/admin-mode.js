(function adminMode(global) {
  "use strict";

  function initAdminMode() {
    var params = new URLSearchParams(global.location.search);
    var enabled = params.get("admin") === "1";

    if (!enabled) {
      return;
    }

    document.body.setAttribute("data-admin-mode", "true");
    console.info("[Simplify] Modo admin activo");
  }

  if (global.SimplifyApp && typeof global.SimplifyApp.registerInit === "function") {
    global.SimplifyApp.registerInit("admin-mode", initAdminMode);
  } else {
    document.addEventListener("DOMContentLoaded", initAdminMode, { once: true });
  }
})(window);
