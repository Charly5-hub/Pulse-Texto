(function setupSky(global) {
  "use strict";

  function initSkyCanvas() {
    var canvas = document.getElementById("sky");
    if (!canvas) {
      return;
    }

    var context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    var reduceMotion = global.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var stars = [];
    var rafId = null;

    function resize() {
      var ratio = Math.max(1, global.devicePixelRatio || 1);
      var width = global.innerWidth;
      var height = global.innerHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      var total = Math.min(140, Math.floor((width * height) / 13000));
      stars = [];
      for (var i = 0; i < total; i += 1) {
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          radius: Math.random() * 1.4 + 0.4,
          alpha: Math.random() * 0.7 + 0.2,
          speed: Math.random() * 0.0025 + 0.0005,
          phase: Math.random() * Math.PI * 2,
        });
      }
    }

    function draw(time) {
      var width = global.innerWidth;
      var height = global.innerHeight;
      context.clearRect(0, 0, width, height);

      for (var i = 0; i < stars.length; i += 1) {
        var star = stars[i];
        var alpha = star.alpha;
        if (!reduceMotion) {
          alpha = Math.max(0.15, Math.min(1, star.alpha + Math.sin(time * star.speed + star.phase) * 0.35));
        }
        context.beginPath();
        context.fillStyle = "rgba(178, 241, 255, " + alpha.toFixed(3) + ")";
        context.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        context.fill();
      }

      if (!reduceMotion) {
        rafId = global.requestAnimationFrame(draw);
      }
    }

    resize();
    draw(0);
    global.addEventListener("resize", resize);

    global.addEventListener("pagehide", function () {
      if (rafId) {
        global.cancelAnimationFrame(rafId);
      }
    });
  }

  if (global.SimplifyApp && typeof global.SimplifyApp.registerInit === "function") {
    global.SimplifyApp.registerInit("sky", initSkyCanvas);
  } else {
    document.addEventListener("DOMContentLoaded", initSkyCanvas, { once: true });
  }
})(window);
