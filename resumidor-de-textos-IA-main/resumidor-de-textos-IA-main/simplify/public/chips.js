(function setupChips(global) {
  "use strict";

  var ACTIONS = [
    { id: "suggest", label: "Sugerencia IA" },
    { id: "summary", label: "Resumen" },
    { id: "simplify", label: "Simplificar" },
    { id: "bullets", label: "Convertir a puntos" },
    { id: "professional", label: "Tono profesional" },
    { id: "translate-en", label: "Traducir a EN" },
    { id: "translate-es", label: "Traducir a ES" },
    { id: "email-pro", label: "Email profesional" },
    { id: "linkedin-post", label: "Post de LinkedIn" },
    { id: "meeting-notes", label: "Minuta de reunión" },
  ];

  var selectedActionId = "suggest";
  var panelRef = null;

  function syncSelectionUI() {
    if (!panelRef) {
      return;
    }

    var buttons = panelRef.querySelectorAll("button[data-action]");
    buttons.forEach(function (button) {
      var isSelected = button.getAttribute("data-action") === selectedActionId;
      button.setAttribute("aria-pressed", isSelected ? "true" : "false");
    });

    var suggestButton = document.getElementById("btn-suggest");
    if (suggestButton) {
      suggestButton.setAttribute("data-action", selectedActionId);
      var selected = ACTIONS.find(function (item) {
        return item.id === selectedActionId;
      });
      suggestButton.title = selected ? "Acción activa: " + selected.label : "Ejecutar";
    }
  }

  function setSelectedAction(actionId) {
    var exists = ACTIONS.some(function (item) {
      return item.id === actionId;
    });

    if (!exists) {
      return;
    }

    selectedActionId = actionId;
    syncSelectionUI();
  }

  function getSelectedAction() {
    return selectedActionId;
  }

  function initChips() {
    var panel = document.getElementById("chips-panel");
    if (!panel) {
      return;
    }

    panelRef = panel;
    panel.innerHTML = "";

    ACTIONS.forEach(function (action) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "chip-btn";
      button.setAttribute("data-action", action.id);
      button.setAttribute("aria-pressed", action.id === selectedActionId ? "true" : "false");
      button.textContent = action.label;
      button.addEventListener("click", function () {
        setSelectedAction(action.id);
      });
      panel.appendChild(button);
    });

    syncSelectionUI();
  }

  global.SimplifyChips = {
    getSelectedAction: getSelectedAction,
    setSelectedAction: setSelectedAction,
    getActions: function getActions() {
      return ACTIONS.slice();
    },
  };

  if (global.SimplifyApp && typeof global.SimplifyApp.registerInit === "function") {
    global.SimplifyApp.registerInit("chips", initChips);
  } else {
    document.addEventListener("DOMContentLoaded", initChips, { once: true });
  }
})(window);
