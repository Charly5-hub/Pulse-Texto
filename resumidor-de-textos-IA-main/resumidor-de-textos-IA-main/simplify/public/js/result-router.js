(function resultRouter(global) {
  "use strict";

  var HASH_TO_TAB = {
    "#resultado": "tab-res",
    "#json": "tab-json",
    "#raw": "tab-raw",
  };

  function resolveFromURL() {
    var hash = (global.location.hash || "").toLowerCase();
    if (HASH_TO_TAB[hash]) {
      return HASH_TO_TAB[hash];
    }

    var params = new URLSearchParams(global.location.search);
    var view = (params.get("view") || "").toLowerCase();
    if (view === "json") {
      return "tab-json";
    }
    if (view === "raw") {
      return "tab-raw";
    }
    return "tab-res";
  }

  function applyRoute() {
    var tabId = resolveFromURL();
    var app = global.SimplifyApp || {};
    var ui = app.ui || {};
    if (typeof ui.selectTab === "function") {
      ui.selectTab(tabId);
    }
  }

  function initResultRouter() {
    applyRoute();
    global.addEventListener("hashchange", applyRoute);
  }

  if (global.SimplifyApp && typeof global.SimplifyApp.registerInit === "function") {
    global.SimplifyApp.registerInit("result-router", initResultRouter);
  } else {
    document.addEventListener("DOMContentLoaded", initResultRouter, { once: true });
  }
})(window);
