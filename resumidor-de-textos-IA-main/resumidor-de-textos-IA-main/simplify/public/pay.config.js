(function bootstrapSimplifyConfig(global) {
  "use strict";

  if (!global) {
    return;
  }

  var app = global.SimplifyApp || {};
  var queue = Array.isArray(app._initQueue) ? app._initQueue : [];

  app._initQueue = queue;
  app.registerInit = app.registerInit || function registerInit(name, run) {
    if (typeof run !== "function") {
      return;
    }
    queue.push({
      name: typeof name === "string" ? name : "anonymous",
      run: run,
    });
  };

  app.runInitializers = app.runInitializers || function runInitializers() {
    if (app._alreadyBooted) {
      return;
    }
    app._alreadyBooted = true;

    while (queue.length > 0) {
      var init = queue.shift();
      try {
        init.run();
      } catch (error) {
        console.error("[Simplify] Error al iniciar " + init.name, error);
      }
    }
  };

  global.SimplifyApp = app;

  var defaults = {
    links: {
      one: "#",
      pack: "#",
      sub: "#",
    },
    freeUses: 3,
    storage: {
      usage: "simplify.usage.v1",
      paidCredits: "simplify.paidCredits.v1",
      adminBypass: "simplify.adminBypass.v1",
      history: "simplify.history.v1",
      prefs: "simplify.prefs.v1",
    },
    backend: {
      endpoint: "",
      timeoutMs: 10000,
      model: "",
      mode: "generic",
      temperature: 0.2,
      headers: {},
    },
  };

  var incoming = global.SIMPLIFY_PAY_CONFIG || {};
  var merged = Object.assign({}, defaults, incoming);
  merged.links = Object.assign({}, defaults.links, incoming.links || {});
  merged.storage = Object.assign({}, defaults.storage, incoming.storage || {});
  merged.backend = Object.assign({}, defaults.backend, incoming.backend || {});

  global.SIMPLIFY_PAY_CONFIG = Object.freeze(merged);
})(window);
