(function wireApp(global) {
  "use strict";

  function boot() {
    if (global.SimplifyApp && typeof global.SimplifyApp.runInitializers === "function") {
      global.SimplifyApp.runInitializers();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})(window);
