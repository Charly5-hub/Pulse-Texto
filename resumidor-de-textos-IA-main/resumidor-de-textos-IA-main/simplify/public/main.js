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
  };

  var STOPWORDS_ES = {
    de: true, la: true, que: true, el: true, en: true, y: true, a: true, los: true,
    del: true, se: true, las: true, por: true, un: true, para: true, con: true, no: true,
    una: true, su: true, al: true, lo: true, como: true, mas: true, más: true, pero: true,
    sus: true, le: true, ya: true, o: true, este: true, si: true, porque: true, esta: true,
    entre: true, cuando: true, muy: true, sin: true, sobre: true, tambien: true, también: true,
  };

  function splitSentences(text) {
    return text
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.!?])\s+/)
      .filter(Boolean);
  }

  function countWords(text) {
    var matches = text.trim().match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+/g);
    return matches ? matches.length : 0;
  }

  function summarize(text) {
    var sentences = splitSentences(text);
    if (sentences.length <= 1) {
      return text.trim();
    }
    var keep = Math.max(1, Math.ceil(sentences.length * 0.35));
    keep = Math.min(5, keep);
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
    ];

    var output = text;
    replacements.forEach(function (pair) {
      output = output.replace(pair[0], pair[1]);
    });

    var sentences = splitSentences(output);
    var shortened = sentences.map(function (sentence) {
      var words = sentence.split(/\s+/);
      if (words.length <= 24) {
        return sentence;
      }
      return words.slice(0, 24).join(" ") + "…";
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
    return buildSuggestion(input);
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

  function initMain() {
    var input = document.getElementById("input");
    var trigger = document.getElementById("btn-suggest");
    var loading = document.getElementById("loading");
    var panelRes = document.getElementById("tab-res");
    var panelJson = document.getElementById("tab-json");
    var panelRaw = document.getElementById("tab-raw");

    if (!input || !trigger || !panelRes || !panelJson || !panelRaw || !loading) {
      return;
    }

    var tabs = createTabController();
    var app = global.SimplifyApp || {};
    app.ui = app.ui || {};
    app.ui.selectTab = tabs.selectTab;
    global.SimplifyApp = app;

    function render(payload) {
      panelRes.textContent = payload.output;
      panelJson.textContent = JSON.stringify(payload, null, 2);
      panelRaw.textContent = payload.input;
      tabs.selectTab("tab-res");
    }

    function setLoadingState(isLoading) {
      loading.hidden = !isLoading;
      trigger.disabled = isLoading;
    }

    trigger.addEventListener("click", function () {
      var text = input.value.trim();
      if (!text) {
        panelRes.textContent = "Pega un texto para poder generar una salida.";
        tabs.selectTab("tab-res");
        return;
      }

      var selectedAction = trigger.getAttribute("data-action") || "suggest";
      var guard = global.SimplifyPayGuard;
      if (guard && !guard.canUse()) {
        panelRes.textContent = "Te quedaste sin usos gratis. Puedes activar créditos para continuar.";
        tabs.selectTab("tab-res");
        return;
      }

      setLoadingState(true);

      global.setTimeout(function () {
        try {
          var output = runAction(selectedAction, text);
          if (guard) {
            guard.consumeUse();
          }

          var payload = {
            action: selectedAction,
            actionLabel: ACTION_LABELS[selectedAction] || selectedAction,
            generatedAt: new Date().toISOString(),
            engine: "local-fallback",
            inputWordCount: countWords(text),
            outputWordCount: countWords(output),
            input: text,
            output: output,
          };

          render(payload);
        } catch (error) {
          panelRes.textContent = "No se pudo procesar el texto. Inténtalo de nuevo.";
          console.error("[Simplify] Error procesando texto", error);
          tabs.selectTab("tab-res");
        } finally {
          setLoadingState(false);
        }
      }, 220);
    });
  }

  if (global.SimplifyApp && typeof global.SimplifyApp.registerInit === "function") {
    global.SimplifyApp.registerInit("main", initMain);
  } else {
    document.addEventListener("DOMContentLoaded", initMain, { once: true });
  }
})(window);
