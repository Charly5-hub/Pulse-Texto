(function setupAIClient(global) {
  "use strict";

  function getBackendConfig() {
    var config = (global.SIMPLIFY_PAY_CONFIG || {}).backend || {};
    return {
      endpoint: typeof config.endpoint === "string" ? config.endpoint.trim() : "",
      timeoutMs: Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 10000,
      model: typeof config.model === "string" ? config.model.trim() : "",
      apiKey: typeof config.apiKey === "string" ? config.apiKey.trim() : "",
      mode: typeof config.mode === "string" ? config.mode.trim() : "generic",
      headers: config.headers && typeof config.headers === "object" ? config.headers : {},
      temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.2,
    };
  }

  function canUseRemote(mode) {
    var backend = getBackendConfig();
    if (mode === "local") {
      return false;
    }
    if (!backend.endpoint) {
      return false;
    }
    return mode === "remote" || mode === "auto";
  }

  function normalizeContent(content) {
    if (typeof content === "string") {
      return content.trim();
    }
    if (Array.isArray(content)) {
      return content.map(function (item) {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item.text === "string") {
          return item.text;
        }
        return "";
      }).join("\n").trim();
    }
    return "";
  }

  function extractOutput(payload) {
    if (!payload) {
      return "";
    }
    if (typeof payload === "string") {
      return payload.trim();
    }
    if (typeof payload.output === "string") {
      return payload.output.trim();
    }
    if (typeof payload.text === "string") {
      return payload.text.trim();
    }
    if (payload.result && typeof payload.result === "string") {
      return payload.result.trim();
    }
    if (payload.data) {
      var nested = extractOutput(payload.data);
      if (nested) {
        return nested;
      }
    }
    if (Array.isArray(payload.choices) && payload.choices.length > 0) {
      var first = payload.choices[0] || {};
      if (first.message && first.message.content) {
        return normalizeContent(first.message.content);
      }
      if (typeof first.text === "string") {
        return first.text.trim();
      }
    }
    if (Array.isArray(payload.content)) {
      return normalizeContent(payload.content);
    }
    return "";
  }

  function buildHeaders(backend) {
    var headers = Object.assign({ "Content-Type": "application/json" }, backend.headers);
    if (backend.apiKey && !headers.Authorization) {
      headers.Authorization = "Bearer " + backend.apiKey;
    }
    if (global.SimplifyAuth && typeof global.SimplifyAuth.authHeaders === "function") {
      headers = global.SimplifyAuth.authHeaders(headers);
    }
    return headers;
  }

  function buildGenericBody(request, backend) {
    return {
      input: request.input,
      action: request.action,
      profile: request.profile,
      style: request.style || "neutral",
      refinement: request.refinement || null,
      locale: request.locale || "es-ES",
      model: backend.model || request.model || "",
      instructions: request.instructions || "",
      systemPrompt: request.systemPrompt || "",
      userPrompt: request.userPrompt || request.input || "",
      metadata: request.metadata || {},
      temperature: backend.temperature,
    };
  }

  function buildOpenAIBody(request, backend) {
    var systemPrompt = request.systemPrompt || "Eres un asistente experto en edición de textos en español.";
    var userPrompt = request.userPrompt || request.input || "";
    return {
      input: request.input,
      model: backend.model || request.model || "gpt-4.1-mini",
      temperature: backend.temperature,
      metadata: request.metadata || {},
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
  }

  function buildRequestBody(request, backend) {
    if (backend.mode === "openai") {
      return buildOpenAIBody(request, backend);
    }
    return buildGenericBody(request, backend);
  }

  function postJSON(url, body, headers, timeoutMs) {
    var controller = new AbortController();
    var timeoutId = global.setTimeout(function () {
      controller.abort();
    }, timeoutMs);

    return fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    }).then(function (response) {
      global.clearTimeout(timeoutId);
      return response.text().then(function (rawText) {
        var json = null;
        if (rawText) {
          try {
            json = JSON.parse(rawText);
          } catch (error) {
            json = null;
          }
        }
        if (!response.ok) {
          var reason = extractOutput(json) || rawText || ("HTTP " + response.status);
          throw new Error(reason);
        }
        return {
          json: json,
          rawText: rawText,
        };
      });
    }).catch(function (error) {
      global.clearTimeout(timeoutId);
      throw error;
    });
  }

  function requestRemote(request, mode) {
    var backend = getBackendConfig();

    if (!backend.endpoint) {
      throw new Error("No hay endpoint remoto configurado.");
    }
    if (mode === "local") {
      throw new Error("Modo local activo.");
    }

    var requestWithCustomer = Object.assign({}, request || {});
    requestWithCustomer.metadata = Object.assign({}, request.metadata || {});
    if (!requestWithCustomer.metadata.customerId && global.SimplifyAuth && typeof global.SimplifyAuth.getCustomerId === "function") {
      requestWithCustomer.metadata.customerId = global.SimplifyAuth.getCustomerId();
    }

    var body = buildRequestBody(requestWithCustomer, backend);
    var headers = buildHeaders(backend);

    return postJSON(backend.endpoint, body, headers, backend.timeoutMs).then(function (response) {
      var output = extractOutput(response.json) || response.rawText.trim();
      if (!output) {
        throw new Error("La API remota respondió sin contenido útil.");
      }
      return {
        engine: "remote",
        output: output,
        model: backend.model || request.model || "remote-model",
        billing: response.json && response.json.billing ? response.json.billing : null,
        balance: response.json && response.json.balance ? response.json.balance : null,
        raw: response.json || response.rawText,
      };
    });
  }

  global.SimplifyAIClient = {
    canUseRemote: canUseRemote,
    requestRemote: requestRemote,
    getBackendConfig: getBackendConfig,
  };
})(window);
