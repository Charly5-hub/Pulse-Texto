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
      customerId: "simplify.customerId.v1",
      authToken: "simplify.authToken.v1",
      authUser: "simplify.authUser.v1",
      legalConsentVersion: "simplify.legalConsentVersion.v1",
    },
    backend: {
      endpoint: "http://localhost:8787/api/ai/generate",
      timeoutMs: 10000,
      model: "",
      mode: "generic",
      temperature: 0.2,
      headers: {},
    },
    monetization: {
      apiBase: "http://localhost:8787",
      eventsPath: "/api/events/track",
      plansPath: "/api/pay/plans",
      checkoutPath: "/api/pay/checkout",
      checkoutStatusPath: "/api/pay/checkout-status",
      balancePath: "/api/pay/balance",
      consumePath: "/api/pay/consume",
      adminMetricsPath: "/api/admin/metrics",
      adminReconcilePath: "/api/admin/reconcile/payments",
      adminGrantPath: "/api/admin/credits/grant",
      oneCredits: 1,
      packCredits: 10,
      subCreditsPerCycle: 250,
    },
    auth: {
      apiBase: "http://localhost:8787",
      anonymousPath: "/api/auth/session/anonymous",
      mePath: "/api/auth/me",
      emailRequestPath: "/api/auth/email/request-code",
      emailVerifyPath: "/api/auth/email/verify-code",
      googlePath: "/api/auth/google",
      googleClientId: "",
    },
    legal: {
      currentVersion: "2026-02",
      consentPath: "/api/legal/consent",
      consentStatusPath: "/api/legal/consent-status",
      requireForCheckout: true,
    },
  };

  var incoming = global.SIMPLIFY_PAY_CONFIG || {};
  var merged = Object.assign({}, defaults, incoming);
  merged.links = Object.assign({}, defaults.links, incoming.links || {});
  merged.storage = Object.assign({}, defaults.storage, incoming.storage || {});
  merged.backend = Object.assign({}, defaults.backend, incoming.backend || {});
  merged.monetization = Object.assign({}, defaults.monetization, incoming.monetization || {});
  merged.auth = Object.assign({}, defaults.auth, incoming.auth || {});
  merged.legal = Object.assign({}, defaults.legal, incoming.legal || {});

  global.SIMPLIFY_PAY_CONFIG = Object.freeze(merged);
})(window);
