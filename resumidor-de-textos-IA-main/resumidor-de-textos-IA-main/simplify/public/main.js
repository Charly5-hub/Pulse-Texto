(function setupMain(global) {
  "use strict";

  var ACTION_LABELS = {
    suggest: "Sugerencia IA",
    summary: "Resumen",
    simplify: "Simplificar",
    bullets: "Convertir a puntos",
    professional: "Tono profesional",
    "translate-en": "Traducir a EN",
    "translate-es": "Traducir a ES",
    "email-pro": "Email profesional",
    "linkedin-post": "Post para LinkedIn",
    "meeting-notes": "Minuta de reunión",
  };

  var PROFILE_LABELS = {
    general: "General",
    study: "Estudio",
    business: "Trabajo/Negocio",
    content: "Contenido y RRSS",
    support: "Soporte/Cliente",
  };

  var PROFILE_INSTRUCTIONS = {
    general: "Entrega una salida clara, precisa y accionable.",
    study: "Prioriza conceptos clave, definiciones y estructura para memorizar mejor.",
    business: "Prioriza tono profesional, foco en impacto y próximos pasos.",
    content: "Prioriza claridad, gancho inicial y lectura rápida en móvil.",
    support: "Prioriza empatía, soluciones concretas y lenguaje sin fricción.",
  };

  var REFINEMENTS = {
    shorter: "Reduce la extensión manteniendo el significado esencial.",
    clearer: "Haz el texto más claro, simple y directo.",
    professional: "Eleva el tono para un entorno profesional y ejecutivo.",
  };

  var STOPWORDS_ES = {
    de: true, la: true, que: true, el: true, en: true, y: true, a: true, los: true,
    del: true, se: true, las: true, por: true, un: true, para: true, con: true, no: true,
    una: true, su: true, al: true, lo: true, como: true, mas: true, más: true, pero: true,
    sus: true, le: true, ya: true, o: true, este: true, si: true, porque: true, esta: true,
    entre: true, cuando: true, muy: true, sin: true, sobre: true, tambien: true, también: true,
  };

  function safeGetJSON(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      if (!raw) {
        return fallback;
      }
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function safeSetJSON(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // Ignore storage write failures.
    }
  }

  function splitSentences(text) {
    return text
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.!?])\s+/)
      .filter(Boolean);
  }

  function countWords(text) {
    var matches = (text || "").trim().match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+/g);
    return matches ? matches.length : 0;
  }

  function summarize(text) {
    var sentences = splitSentences(text);
    if (sentences.length <= 1) {
      return text.trim();
    }
    var keep = Math.max(1, Math.ceil(sentences.length * 0.35));
    keep = Math.min(6, keep);
    return sentences.slice(0, keep).join(" ");
  }

  function simplifySpanish(text) {
    var replacements = [
      [/\bmetodolog[ií]a\b/gi, "método"],
      [/\bimplementaci[oó]n\b/gi, "puesta en marcha"],
      [/\boptimizar\b/gi, "mejorar"],
      [/\bcomplejidad\b/gi, "dificultad"],
      [/\bestrategia\b/gi, "plan"],
      [/\bobtener\b/gi, "lograr"],
      [/\brealizar\b/gi, "hacer"],
      [/\baproximadamente\b/gi, "casi"],
      [/\bactualmente\b/gi, "hoy"],
      [/\bcon la finalidad de\b/gi, "para"],
      [/\bdicho\b/gi, "ese"],
      [/\bpor consiguiente\b/gi, "por eso"],
    ];

    var output = text;
    replacements.forEach(function (pair) {
      output = output.replace(pair[0], pair[1]);
    });

    var sentences = splitSentences(output);
    var shortened = sentences.map(function (sentence) {
      var words = sentence.split(/\s+/);
      if (words.length <= 22) {
        return sentence;
      }
      return words.slice(0, 22).join(" ") + "…";
    });

    return shortened.join(" ").trim();
  }

  function bullets(text) {
    var lines = splitSentences(text);
    if (lines.length === 0) {
      lines = text.split(/\n+/).filter(Boolean);
    }
    return lines.map(function (line) {
      return "• " + line.trim();
    }).join("\n");
  }

  function toProfessionalTone(text) {
    var normalized = text
      .replace(/\s+/g, " ")
      .replace(/\b(creo que|pienso que)\b/gi, "considero que")
      .replace(/\bok\b/gi, "de acuerdo")
      .replace(/\bcosa\b/gi, "aspecto")
      .trim();

    if (!normalized) {
      return "";
    }

    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  function replaceWords(text, dictionary) {
    return text.replace(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+/g, function (word) {
      var lower = word.toLowerCase();
      var translated = dictionary[lower];
      if (!translated) {
        return word;
      }
      if (word[0] === word[0].toUpperCase()) {
        return translated.charAt(0).toUpperCase() + translated.slice(1);
      }
      return translated;
    });
  }

  function translateToEnglish(text) {
    var dict = {
      hola: "hello",
      texto: "text",
      resumen: "summary",
      claro: "clear",
      rapido: "fast",
      rápido: "fast",
      profesional: "professional",
      estudiante: "student",
      trabajo: "work",
      importante: "important",
      proyecto: "project",
      resultados: "results",
      resultado: "result",
      mejorar: "improve",
      traduccion: "translation",
      traducción: "translation",
      cliente: "client",
      soporte: "support",
    };
    return replaceWords(text, dict);
  }

  function translateToSpanish(text) {
    var dict = {
      hello: "hola",
      text: "texto",
      summary: "resumen",
      clear: "claro",
      fast: "rápido",
      professional: "profesional",
      student: "estudiante",
      work: "trabajo",
      important: "importante",
      project: "proyecto",
      results: "resultados",
      result: "resultado",
      improve: "mejorar",
      translation: "traducción",
      client: "cliente",
      support: "soporte",
    };
    return replaceWords(text, dict);
  }

  function topKeywords(text, limit) {
    var words = (text.toLowerCase().match(/[a-záéíóúüñ]{3,}/g) || []);
    var counts = {};

    words.forEach(function (word) {
      if (STOPWORDS_ES[word]) {
        return;
      }
      counts[word] = (counts[word] || 0) + 1;
    });

    return Object.keys(counts)
      .sort(function (a, b) {
        return counts[b] - counts[a];
      })
      .slice(0, limit || 5);
  }

  function buildSuggestion(text) {
    var shortSummary = summarize(text);
    var keywords = topKeywords(text, 4);
    var points = keywords.length > 0
      ? keywords.map(function (item) { return "• " + item; }).join("\n")
      : "• No se detectaron palabras clave.";

    return [
      "Resumen breve:",
      shortSummary,
      "",
      "Palabras clave:",
      points,
    ].join("\n");
  }

  function buildEmail(text) {
    var summary = summarize(text);
    return [
      "Asunto: Propuesta de siguiente paso",
      "",
      "Hola,",
      "",
      toProfessionalTone(summary),
      "",
      "Quedo atento para coordinar próximos pasos.",
      "",
      "Un saludo,",
      "[Tu nombre]",
    ].join("\n");
  }

  function buildLinkedInPost(text) {
    var summary = summarize(text);
    var keywords = topKeywords(text, 3);
    var tags = keywords.map(function (item) { return "#" + item; }).join(" ");
    return [
      "Idea clave:",
      summary,
      "",
      "¿Cómo lo estás abordando en tu equipo?",
      "",
      tags || "#productividad #comunicacion #ia",
    ].join("\n");
  }

  function buildMeetingNotes(text) {
    var lines = splitSentences(text);
    var summary = lines.slice(0, 3).map(function (line) {
      return "• " + line.trim();
    }).join("\n");
    return [
      "Resumen de reunión",
      "",
      "Puntos principales:",
      summary || "• Sin puntos detectados.",
      "",
      "Acuerdos:",
      "• [Pendiente completar]",
      "",
      "Próximos pasos:",
      "• [Responsable] [Fecha] [Acción]",
    ].join("\n");
  }

  function runAction(actionId, input) {
    var selected = actionId || "suggest";
    if (selected === "summary") {
      return summarize(input);
    }
    if (selected === "simplify") {
      return simplifySpanish(input);
    }
    if (selected === "bullets") {
      return bullets(input);
    }
    if (selected === "professional") {
      return toProfessionalTone(input);
    }
    if (selected === "translate-en") {
      return translateToEnglish(input);
    }
    if (selected === "translate-es") {
      return translateToSpanish(input);
    }
    if (selected === "email-pro") {
      return buildEmail(input);
    }
    if (selected === "linkedin-post") {
      return buildLinkedInPost(input);
    }
    if (selected === "meeting-notes") {
      return buildMeetingNotes(input);
    }
    return buildSuggestion(input);
  }

  function applyRefinementLocal(output, refinement) {
    if (!refinement) {
      return output;
    }
    if (refinement === "shorter") {
      return summarize(output);
    }
    if (refinement === "clearer") {
      return simplifySpanish(output);
    }
    if (refinement === "professional") {
      return toProfessionalTone(output);
    }
    return output;
  }

  function estimateSentenceComplexity(text) {
    var words = countWords(text);
    var sentences = splitSentences(text).length || 1;
    return Number((words / sentences).toFixed(1));
  }

  function buildQualityMetrics(input, output) {
    var inputWords = countWords(input);
    var outputWords = countWords(output);
    var compression = 0;
    if (inputWords > 0) {
      compression = Math.round((1 - (outputWords / inputWords)) * 100);
    }

    return {
      inputWords: inputWords,
      outputWords: outputWords,
      compressionPct: compression,
      inputComplexity: estimateSentenceComplexity(input),
      outputComplexity: estimateSentenceComplexity(output),
      outputKeywords: topKeywords(output, 3),
    };
  }

  function createTabController() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
    var panels = Array.prototype.slice.call(document.querySelectorAll('[role="tabpanel"]'));

    function selectTab(panelId) {
      buttons.forEach(function (button) {
        var selected = button.getAttribute("aria-controls") === panelId;
        button.setAttribute("aria-selected", selected ? "true" : "false");
      });

      panels.forEach(function (panel) {
        var selected = panel.id === panelId;
        panel.hidden = !selected;
        panel.tabIndex = selected ? 0 : -1;
      });
    }

    buttons.forEach(function (button, index) {
      button.addEventListener("click", function () {
        selectTab(button.getAttribute("aria-controls"));
      });
      button.addEventListener("keydown", function (event) {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
          return;
        }
        event.preventDefault();
        var nextIndex = event.key === "ArrowRight" ? index + 1 : index - 1;
        if (nextIndex < 0) {
          nextIndex = buttons.length - 1;
        }
        if (nextIndex >= buttons.length) {
          nextIndex = 0;
        }
        buttons[nextIndex].focus();
        selectTab(buttons[nextIndex].getAttribute("aria-controls"));
      });
    });

    return {
      selectTab: selectTab,
    };
  }

  function buildInstructions(actionId, profile, refinement) {
    var actionLabel = ACTION_LABELS[actionId] || actionId;
    var profileInstruction = PROFILE_INSTRUCTIONS[profile] || PROFILE_INSTRUCTIONS.general;
    var parts = [
      "Acción solicitada: " + actionLabel + ".",
      "Perfil de uso: " + (PROFILE_LABELS[profile] || "General") + ".",
      profileInstruction,
      "Responde en español neutro, con alta claridad y sin relleno.",
    ];

    if (refinement && REFINEMENTS[refinement]) {
      parts.push("Refinado adicional: " + REFINEMENTS[refinement]);
    }

    return parts.join(" ");
  }

  function buildSystemPrompt(actionId, profile, refinement) {
    return [
      "Eres un editor experto en comunicación escrita.",
      "Prioriza precisión, utilidad práctica y legibilidad.",
      buildInstructions(actionId, profile, refinement),
      "No inventes datos. Si falta contexto, trabaja solo con el texto dado.",
    ].join(" ");
  }

  function buildUserPrompt(input) {
    return [
      "Transforma el siguiente texto:",
      "",
      input,
    ].join("\n");
  }

  function generateId() {
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function formatDate(iso) {
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }
    return date.toLocaleString("es-ES", {
      dateStyle: "short",
      timeStyle: "short",
    });
  }

  function copyToClipboard(text) {
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      return global.navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var temp = document.createElement("textarea");
        temp.value = text;
        temp.setAttribute("readonly", "");
        temp.style.position = "absolute";
        temp.style.left = "-9999px";
        document.body.appendChild(temp);
        temp.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(temp);
        if (!ok) {
          reject(new Error("No se pudo copiar."));
          return;
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  function initMain() {
    var input = document.getElementById("input");
    var trigger = document.getElementById("btn-suggest");
    var loading = document.getElementById("loading");
    var panelRes = document.getElementById("tab-res");
    var panelJson = document.getElementById("tab-json");
    var panelRaw = document.getElementById("tab-raw");
    var engineMode = document.getElementById("engine-mode");
    var profileMode = document.getElementById("intent-profile");
    var engineHint = document.getElementById("engine-hint");
    var statusLine = document.getElementById("status-line");
    var qualityBadges = document.getElementById("quality-badges");
    var copyButton = document.getElementById("btn-copy");
    var refineButtons = Array.prototype.slice.call(document.querySelectorAll(".refine-btn"));
    var historyList = document.getElementById("history-list");
    var historyEmpty = document.getElementById("history-empty");

    if (!input || !trigger || !loading || !panelRes || !panelJson || !panelRaw) {
      return;
    }

    var tabs = createTabController();
    var app = global.SimplifyApp || {};
    app.ui = app.ui || {};
    app.ui.selectTab = tabs.selectTab;
    global.SimplifyApp = app;

    var config = global.SIMPLIFY_PAY_CONFIG || {};
    var storage = config.storage || {};
    var historyKey = storage.history || "simplify.history.v1";
    var prefsKey = storage.prefs || "simplify.prefs.v1";
    var historyLimit = 10;

    var storedHistory = safeGetJSON(historyKey, []);
    var state = {
      busy: false,
      last: null,
      history: Array.isArray(storedHistory) ? storedHistory : [],
    };

    function getMode() {
      return engineMode ? engineMode.value : "auto";
    }

    function getProfile() {
      return profileMode ? profileMode.value : "general";
    }

    function setLoadingState(isLoading) {
      state.busy = isLoading;
      loading.hidden = !isLoading;
      trigger.disabled = isLoading;
      if (copyButton) {
        copyButton.disabled = isLoading;
      }
      refineButtons.forEach(function (button) {
        button.disabled = isLoading;
      });
    }

    function renderQuality(quality) {
      if (!qualityBadges || !quality) {
        return;
      }
      qualityBadges.innerHTML = "";

      var items = [
        "Palabras: " + quality.inputWords + " → " + quality.outputWords,
        "Compresión: " + quality.compressionPct + "%",
        "Complejidad media: " + quality.inputComplexity + " → " + quality.outputComplexity,
      ];

      if (Array.isArray(quality.outputKeywords) && quality.outputKeywords.length > 0) {
        items.push("Claves: " + quality.outputKeywords.join(", "));
      }

      items.forEach(function (text) {
        var badge = document.createElement("span");
        badge.className = "quality-badge";
        badge.textContent = text;
        qualityBadges.appendChild(badge);
      });
    }

    function render(payload) {
      panelRes.textContent = payload.output;
      panelJson.textContent = JSON.stringify(payload, null, 2);
      panelRaw.textContent = payload.input;
      tabs.selectTab("tab-res");
      renderQuality(payload.quality);
      if (statusLine) {
        var status = "Motor: " + (payload.engineLabel || "local");
        if (payload.fallbackReason) {
          status += " · Fallback local: " + payload.fallbackReason;
        }
        statusLine.textContent = status;
      }
      if (copyButton) {
        copyButton.disabled = !payload.output;
      }
    }

    function saveHistory() {
      safeSetJSON(historyKey, state.history);
    }

    function pushHistory(payload) {
      var entry = {
        id: payload.id,
        action: payload.action,
        actionLabel: payload.actionLabel,
        profile: payload.profile,
        profileLabel: payload.profileLabel,
        engineLabel: payload.engineLabel || "local",
        generatedAt: payload.generatedAt,
        input: payload.input,
        output: payload.output,
        quality: payload.quality,
      };
      state.history = [entry].concat(state.history.filter(function (item) {
        return item.id !== entry.id;
      })).slice(0, historyLimit);
      saveHistory();
      renderHistory();
    }

    function restoreFromHistory(entry) {
      if (!entry) {
        return;
      }
      input.value = entry.input || "";
      state.last = entry;
      render(entry);
    }

    function renderHistory() {
      if (!historyList || !historyEmpty) {
        return;
      }

      historyList.innerHTML = "";
      if (!state.history.length) {
        historyEmpty.hidden = false;
        return;
      }
      historyEmpty.hidden = true;

      state.history.forEach(function (entry) {
        var item = document.createElement("li");
        item.className = "history-item";

        var button = document.createElement("button");
        button.type = "button";
        button.addEventListener("click", function () {
          restoreFromHistory(entry);
        });

        var title = document.createElement("strong");
        title.textContent = entry.actionLabel + " · " + entry.profileLabel;
        var excerpt = document.createElement("small");
        excerpt.textContent = (entry.output || "").slice(0, 160) + ((entry.output || "").length > 160 ? "…" : "");
        var meta = document.createElement("small");
        meta.textContent = formatDate(entry.generatedAt) + " · " + entry.engineLabel;

        button.appendChild(title);
        button.appendChild(excerpt);
        button.appendChild(meta);
        item.appendChild(button);
        historyList.appendChild(item);
      });
    }

    function savePrefs() {
      safeSetJSON(prefsKey, {
        mode: getMode(),
        profile: getProfile(),
      });
    }

    function loadPrefs() {
      var prefs = safeGetJSON(prefsKey, {});
      if (engineMode && typeof prefs.mode === "string") {
        engineMode.value = prefs.mode;
      }
      if (profileMode && typeof prefs.profile === "string") {
        profileMode.value = prefs.profile;
      }
    }

    function updateEngineHint() {
      if (!engineHint) {
        return;
      }
      var backend = global.SimplifyAIClient && global.SimplifyAIClient.getBackendConfig
        ? global.SimplifyAIClient.getBackendConfig()
        : { endpoint: "" };
      var hasEndpoint = Boolean(backend.endpoint);
      if (getMode() === "local") {
        engineHint.textContent = "Modo local activo: velocidad máxima, sin dependencia de API.";
        return;
      }
      if (getMode() === "remote") {
        engineHint.textContent = hasEndpoint
          ? "Modo remoto activo: usará la API configurada."
          : "Modo remoto sin endpoint: usará fallback local hasta configurar backend.";
        return;
      }
      engineHint.textContent = hasEndpoint
        ? "Auto: intentará API remota y hará fallback local si falla."
        : "Auto: no hay endpoint configurado, se usará motor local.";
    }

    function runLocal(request) {
      var base = runAction(request.action, request.input);
      var output = applyRefinementLocal(base, request.refinement);
      return Promise.resolve({
        output: output,
        engine: "local-fallback",
        model: "local-rule-engine",
      });
    }

    function runHybrid(request, mode) {
      var client = global.SimplifyAIClient;
      if (!client || !client.canUseRemote(mode)) {
        if (mode === "remote") {
          return runLocal(request).then(function (result) {
            result.fallbackError = "Endpoint remoto no configurado";
            return result;
          });
        }
        return runLocal(request);
      }

      return client.requestRemote(request, mode).catch(function (error) {
        return runLocal(request).then(function (localResult) {
          localResult.fallbackError = error && error.message ? error.message : "Error remoto";
          return localResult;
        });
      });
    }

    function buildRequest(options) {
      var instructions = buildInstructions(options.action, options.profile, options.refinement);
      var customerId = "";
      if (global.SimplifyPayGuard && typeof global.SimplifyPayGuard.getCustomerId === "function") {
        customerId = global.SimplifyPayGuard.getCustomerId();
      }
      return {
        input: options.input,
        action: options.action,
        profile: options.profile,
        refinement: options.refinement || "",
        locale: "es-ES",
        instructions: instructions,
        systemPrompt: buildSystemPrompt(options.action, options.profile, options.refinement),
        userPrompt: buildUserPrompt(options.input),
        metadata: {
          source: options.source || "user",
          appVersion: "2026.02",
          customerId: customerId,
        },
      };
    }

    function engineLabelFromResult(result) {
      if (!result || !result.engine) {
        return "desconocido";
      }
      if (result.engine === "remote") {
        return "remoto (" + (result.model || "modelo") + ")";
      }
      return "local";
    }

    function execute(options) {
      var text = (options.input || "").trim();
      var guard = global.SimplifyPayGuard;
      if (!text) {
        panelRes.textContent = "Pega un texto para poder generar una salida.";
        tabs.selectTab("tab-res");
        if (guard && typeof guard.trackEvent === "function") {
          guard.trackEvent("generation_empty_input", {
            source: options.source || "primary",
          });
        }
        return;
      }

      if (options.consumeCredit && guard && !guard.canUse()) {
        panelRes.textContent = "Te quedaste sin usos gratis. Puedes activar créditos para continuar.";
        tabs.selectTab("tab-res");
        if (typeof guard.trackEvent === "function") {
          guard.trackEvent("credits_blocked", {
            action: options.action,
            source: options.source || "primary",
          });
        }
        return;
      }

      setLoadingState(true);
      var mode = getMode();
      var profile = getProfile();
      var request = buildRequest({
        input: text,
        action: options.action,
        profile: profile,
        refinement: options.refinement,
        source: options.source,
      });

      runHybrid(request, mode).then(function (result) {
        if (options.consumeCredit && guard) {
          guard.consumeUse();
        }

        var output = (result.output || "").trim();
        if (!output) {
          output = "No se pudo generar una salida útil con el contenido recibido.";
        }

        var payload = {
          id: generateId(),
          action: options.action,
          actionLabel: ACTION_LABELS[options.action] || options.action,
          profile: profile,
          profileLabel: PROFILE_LABELS[profile] || "General",
          refinement: options.refinement || "",
          refinementInstruction: options.refinement ? REFINEMENTS[options.refinement] : "",
          generatedAt: new Date().toISOString(),
          modeSelected: mode,
          engine: result.engine || "local-fallback",
          engineLabel: engineLabelFromResult(result),
          model: result.model || "",
          fallbackReason: result.fallbackError || "",
          inputWordCount: countWords(text),
          outputWordCount: countWords(output),
          instructions: request.instructions,
          input: text,
          output: output,
          quality: buildQualityMetrics(text, output),
          remoteRaw: result.raw || null,
        };

        state.last = payload;
        pushHistory(payload);
        render(payload);
        if (guard && typeof guard.trackEvent === "function") {
          guard.trackEvent("generation_completed", {
            action: payload.action,
            profile: payload.profile,
            mode: payload.modeSelected,
            engine: payload.engine,
            inputWords: payload.inputWordCount,
            outputWords: payload.outputWordCount,
            compressionPct: payload.quality && payload.quality.compressionPct,
            refinement: payload.refinement || "",
          });
        }
      }).catch(function (error) {
        panelRes.textContent = "No se pudo procesar el texto. Inténtalo de nuevo.";
        if (statusLine) {
          statusLine.textContent = "Error: " + (error && error.message ? error.message : "fallo inesperado");
        }
        tabs.selectTab("tab-res");
        if (guard && typeof guard.trackEvent === "function") {
          guard.trackEvent("generation_failed", {
            action: options.action,
            source: options.source || "primary",
            reason: error && error.message ? error.message : "unknown",
          });
        }
      }).finally(function () {
        setLoadingState(false);
      });
    }

    function runPrimaryAction() {
      var selectedAction = trigger.getAttribute("data-action") || "suggest";
      execute({
        input: input.value,
        action: selectedAction,
        source: "primary",
        consumeCredit: true,
      });
    }

    trigger.addEventListener("click", runPrimaryAction);

    input.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        runPrimaryAction();
      }
    });

    refineButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        if (!state.last || !state.last.output) {
          if (statusLine) {
            statusLine.textContent = "Genera primero un resultado para poder refinarlo.";
          }
          return;
        }

        if (global.SimplifyPayGuard && typeof global.SimplifyPayGuard.trackEvent === "function") {
          global.SimplifyPayGuard.trackEvent("refine_clicked", {
            refine: button.getAttribute("data-refine") || "",
            action: state.last.action || "suggest",
          });
        }

        execute({
          input: state.last.output,
          action: state.last.action || "suggest",
          refinement: button.getAttribute("data-refine") || "",
          source: "refine",
          consumeCredit: false,
        });
      });
    });

    if (copyButton) {
      copyButton.disabled = true;
      copyButton.addEventListener("click", function () {
        if (!state.last || !state.last.output) {
          return;
        }
        copyToClipboard(state.last.output).then(function () {
          if (statusLine) {
            statusLine.textContent = "Resultado copiado al portapapeles.";
          }
          if (global.SimplifyPayGuard && typeof global.SimplifyPayGuard.trackEvent === "function") {
            global.SimplifyPayGuard.trackEvent("result_copied", {
              action: state.last.action || "suggest",
              profile: state.last.profile || "general",
            });
          }
        }).catch(function () {
          if (statusLine) {
            statusLine.textContent = "No se pudo copiar automáticamente. Copia manualmente.";
          }
        });
      });
    }

    if (engineMode) {
      engineMode.addEventListener("change", function () {
        savePrefs();
        updateEngineHint();
      });
    }
    if (profileMode) {
      profileMode.addEventListener("change", function () {
        savePrefs();
      });
    }

    loadPrefs();
    updateEngineHint();
    renderHistory();
    if (state.history.length > 0) {
      restoreFromHistory(state.history[0]);
    }
  }

  if (global.SimplifyApp && typeof global.SimplifyApp.registerInit === "function") {
    global.SimplifyApp.registerInit("main", initMain);
  } else {
    document.addEventListener("DOMContentLoaded", initMain, { once: true });
  }
})(window);
