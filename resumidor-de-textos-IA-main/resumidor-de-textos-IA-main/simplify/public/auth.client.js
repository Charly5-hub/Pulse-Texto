(function setupAuthClient(global) {
  "use strict";

  var config = global.SIMPLIFY_PAY_CONFIG || {};
  var storage = config.storage || {};
  var authConfig = config.auth || {};

  var tokenKey = storage.authToken || "simplify.authToken.v1";
  var userKey = storage.authUser || "simplify.authUser.v1";
  var customerKey = storage.customerId || "simplify.customerId.v1";

  var listeners = [];
  var state = {
    token: "",
    user: null,
  };

  function safeGet(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function safeSet(key, value) {
    try {
      global.localStorage.setItem(key, value);
    } catch (error) {
      // Ignore storage write errors.
    }
  }

  function safeRemove(key) {
    try {
      global.localStorage.removeItem(key);
    } catch (error) {
      // Ignore storage write errors.
    }
  }

  function toNonEmptyString(value) {
    var normalized = typeof value === "string" ? value.trim() : "";
    return normalized || "";
  }

  function trimTrailingSlash(value) {
    return toNonEmptyString(value).replace(/\/+$/, "");
  }

  function getApiBase() {
    return trimTrailingSlash(authConfig.apiBase || "");
  }

  function getPath(pathValue, fallback) {
    var candidate = toNonEmptyString(pathValue || "");
    return candidate || fallback;
  }

  function getCustomerId() {
    var current = toNonEmptyString(safeGet(customerKey));
    if (current) {
      return current;
    }
    var generated = "cust_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
    safeSet(customerKey, generated);
    return generated;
  }

  function setCustomerId(value) {
    var normalized = toNonEmptyString(value);
    if (!normalized) {
      return;
    }
    safeSet(customerKey, normalized);
  }

  function setStatus(text) {
    var node = document.getElementById("auth-status");
    if (!node) {
      return;
    }
    node.textContent = text || "";
  }

  function notify() {
    var snapshot = api.getState();
    listeners.forEach(function (listener) {
      try {
        listener(snapshot);
      } catch (error) {
        // noop
      }
    });
  }

  function readUserFromStorage() {
    var raw = safeGet(userKey);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }

  function saveState(token, user) {
    state.token = toNonEmptyString(token);
    state.user = user && typeof user === "object" ? user : null;

    if (state.token) {
      safeSet(tokenKey, state.token);
    } else {
      safeRemove(tokenKey);
    }

    if (state.user) {
      safeSet(userKey, JSON.stringify(state.user));
      if (state.user.customerId) {
        setCustomerId(state.user.customerId);
      }
    } else {
      safeRemove(userKey);
    }

    notify();
    if (global.SimplifyPayGuard && typeof global.SimplifyPayGuard.syncRemoteBalance === "function") {
      global.SimplifyPayGuard.syncRemoteBalance(true);
    }
  }

  function authHeaders(extraHeaders) {
    var headers = Object.assign({}, extraHeaders || {});
    if (state.token) {
      headers.Authorization = "Bearer " + state.token;
    }
    return headers;
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

  function buildURL(pathValue) {
    var base = getApiBase();
    if (!base) {
      return "";
    }
    if (!pathValue) {
      return base;
    }
    return pathValue.charAt(0) === "/" ? (base + pathValue) : (base + "/" + pathValue);
  }

  function applyAuthPayload(payload) {
    var token = toNonEmptyString(payload && payload.token);
    var user = payload && payload.user ? payload.user : null;
    saveState(token, user);
  }

  function ensureAnonymousSession() {
    var base = getApiBase();
    if (!base) {
      return Promise.resolve({ ok: false, reason: "api-base-missing" });
    }
    if (state.token) {
      return Promise.resolve({ ok: true, existing: true });
    }

    var anonymousPath = getPath(authConfig.anonymousPath, "/api/auth/session/anonymous");
    return fetchJSON(buildURL(anonymousPath), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: getCustomerId() }),
    }).then(function (payload) {
      applyAuthPayload(payload);
      return { ok: true };
    }).catch(function (error) {
      return { ok: false, reason: error && error.message ? error.message : "anonymous-session-failed" };
    });
  }

  function validateExistingSession() {
    var base = getApiBase();
    if (!base || !state.token) {
      return Promise.resolve();
    }
    var mePath = getPath(authConfig.mePath, "/api/auth/me");
    return fetchJSON(buildURL(mePath), {
      method: "GET",
      headers: authHeaders({ "Content-Type": "application/json" }),
    }).then(function (payload) {
      if (payload && payload.user) {
        saveState(state.token, payload.user);
      }
    }).catch(function () {
      saveState("", null);
    });
  }

  function requestEmailCode(email) {
    var normalized = toNonEmptyString(email).toLowerCase();
    if (!normalized) {
      return Promise.reject(new Error("Email obligatorio."));
    }
    var path = getPath(authConfig.emailRequestPath, "/api/auth/email/request-code");
    return fetchJSON(buildURL(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: normalized,
        customerId: getCustomerId(),
      }),
    });
  }

  function verifyEmailCode(email, code) {
    var normalized = toNonEmptyString(email).toLowerCase();
    var otp = toNonEmptyString(code);
    if (!normalized || !otp) {
      return Promise.reject(new Error("Email y código son obligatorios."));
    }
    var path = getPath(authConfig.emailVerifyPath, "/api/auth/email/verify-code");
    return fetchJSON(buildURL(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: normalized,
        code: otp,
        customerId: getCustomerId(),
      }),
    }).then(function (payload) {
      applyAuthPayload(payload);
      return payload;
    });
  }

  function loginWithGoogleIdToken(idToken) {
    var token = toNonEmptyString(idToken);
    if (!token) {
      return Promise.reject(new Error("Token Google vacío."));
    }
    var path = getPath(authConfig.googlePath, "/api/auth/google");
    return fetchJSON(buildURL(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idToken: token,
        customerId: getCustomerId(),
      }),
    }).then(function (payload) {
      applyAuthPayload(payload);
      return payload;
    });
  }

  function logout() {
    saveState("", null);
    return ensureAnonymousSession();
  }

  function updateAuthUI() {
    var user = state.user;
    var status = "";
    var logoutButton = document.getElementById("btn-auth-logout");
    if (user && user.email) {
      status = "Sesión activa: " + user.email + " (" + (user.provider || "auth") + ")";
      if (logoutButton) {
        logoutButton.hidden = false;
      }
    } else {
      status = "Sesión anónima activa. Inicia sesión para sincronizar tu saldo entre dispositivos.";
      if (logoutButton) {
        logoutButton.hidden = true;
      }
    }
    setStatus(status);
  }

  function initGoogleLogin(retries) {
    var container = document.getElementById("google-login-container");
    if (!container) {
      return;
    }

    var clientId = toNonEmptyString(authConfig.googleClientId);
    if (!clientId) {
      container.innerHTML = "";
      return;
    }

    if (!global.google || !global.google.accounts || !global.google.accounts.id) {
      if (retries > 0) {
        global.setTimeout(function () {
          initGoogleLogin(retries - 1);
        }, 450);
      }
      return;
    }

    global.google.accounts.id.initialize({
      client_id: clientId,
      callback: function onGoogleCredential(response) {
        var credential = toNonEmptyString(response && response.credential);
        if (!credential) {
          setStatus("Google no devolvió credencial válida.");
          return;
        }
        loginWithGoogleIdToken(credential).then(function () {
          setStatus("Login con Google completado.");
        }).catch(function (error) {
          setStatus("Error Google Login: " + (error && error.message ? error.message : "fallo"));
        });
      },
    });

    container.innerHTML = "";
    global.google.accounts.id.renderButton(container, {
      theme: "outline",
      size: "large",
      shape: "pill",
      text: "continue_with",
    });
  }

  function initUI() {
    var requestButton = document.getElementById("btn-auth-request");
    var verifyButton = document.getElementById("btn-auth-verify");
    var logoutButton = document.getElementById("btn-auth-logout");
    var emailInput = document.getElementById("auth-email");
    var codeInput = document.getElementById("auth-code");
    var hint = document.getElementById("auth-hint");

    function currentEmail() {
      return emailInput ? emailInput.value : "";
    }
    function currentCode() {
      return codeInput ? codeInput.value : "";
    }

    if (requestButton) {
      requestButton.addEventListener("click", function () {
        requestButton.disabled = true;
        requestEmailCode(currentEmail()).then(function (payload) {
          var message = "Código enviado.";
          if (payload && payload.devCode) {
            message += " DEV OTP: " + payload.devCode;
          }
          setStatus(message);
        }).catch(function (error) {
          setStatus("No se pudo enviar código: " + (error && error.message ? error.message : "error"));
        }).finally(function () {
          requestButton.disabled = false;
        });
      });
    }

    if (verifyButton) {
      verifyButton.addEventListener("click", function () {
        verifyButton.disabled = true;
        verifyEmailCode(currentEmail(), currentCode()).then(function () {
          setStatus("Sesión iniciada correctamente.");
          if (codeInput) {
            codeInput.value = "";
          }
        }).catch(function (error) {
          setStatus("No se pudo verificar código: " + (error && error.message ? error.message : "error"));
        }).finally(function () {
          verifyButton.disabled = false;
        });
      });
    }

    if (logoutButton) {
      logoutButton.addEventListener("click", function () {
        logout().then(function () {
          setStatus("Sesión cerrada.");
        });
      });
    }

    if (hint) {
      var googleConfigured = toNonEmptyString(authConfig.googleClientId);
      hint.hidden = Boolean(googleConfigured);
    }

    initGoogleLogin(8);
    updateAuthUI();
  }

  var api = {
    getToken: function getToken() {
      return state.token;
    },
    getUser: function getUser() {
      return state.user;
    },
    getCustomerId: getCustomerId,
    setCustomerId: setCustomerId,
    isAuthenticated: function isAuthenticated() {
      return Boolean(state.token && state.user);
    },
    authHeaders: authHeaders,
    ensureAnonymousSession: ensureAnonymousSession,
    requestEmailCode: requestEmailCode,
    verifyEmailCode: verifyEmailCode,
    loginWithGoogleIdToken: loginWithGoogleIdToken,
    logout: logout,
    getState: function getState() {
      return {
        token: state.token,
        user: state.user,
      };
    },
    onChange: function onChange(listener) {
      if (typeof listener !== "function") {
        return function noop() {};
      }
      listeners.push(listener);
      return function unsubscribe() {
        listeners = listeners.filter(function (item) {
          return item !== listener;
        });
      };
    },
  };

  global.SimplifyAuth = api;

  state.token = toNonEmptyString(safeGet(tokenKey));
  state.user = readUserFromStorage();
  notify();

  function initAuth() {
    validateExistingSession().then(function () {
      if (!state.token) {
        return ensureAnonymousSession();
      }
      return null;
    }).finally(function () {
      initUI();
      updateAuthUI();
      api.onChange(updateAuthUI);
    });
  }

  if (global.SimplifyApp && typeof global.SimplifyApp.registerInit === "function") {
    global.SimplifyApp.registerInit("auth-client", initAuth);
  } else {
    document.addEventListener("DOMContentLoaded", initAuth, { once: true });
  }
})(window);
