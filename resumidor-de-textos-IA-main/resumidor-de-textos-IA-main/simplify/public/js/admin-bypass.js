(function adminBypass(global) {
  "use strict";

  function initAdminBypass() {
    var guard = global.SimplifyPayGuard;
    if (!guard) {
      return;
    }

    var params = new URLSearchParams(global.location.search);
    if (params.get("bypass") === "1") {
      guard.setBypass(true);
      console.info("[Simplify] Bypass de usos activado desde URL");
      return;
    }

    if (params.get("bypass") === "0") {
      guard.setBypass(false);
      console.info("[Simplify] Bypass de usos desactivado desde URL");
    }
  }

  if (global.SimplifyApp && typeof global.SimplifyApp.registerInit === "function") {
    global.SimplifyApp.registerInit("admin-bypass", initAdminBypass);
  } else {
    document.addEventListener("DOMContentLoaded", initAdminBypass, { once: true });
  }
})(window);
