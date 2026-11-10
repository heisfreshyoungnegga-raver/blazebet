/* BlazeBet redesign helpers: game-page flag + bottom tab bar active state. */
(function () {
  "use strict";
  var path = location.pathname;
  if (/\/gh\/casino\/[a-z-]+\//.test(path)) document.documentElement.classList.add("bb-game");

  function markTabBar() {
    var bars = document.querySelectorAll("div.fixed.bottom-0, div[class*='fixed'][class*='bottom-0']");
    bars.forEach(function (bar) {
      if (!bar.querySelector("a")) return;
      bar.classList.add("bb-tabbar");
      bar.querySelectorAll("a").forEach(function (a) {
        var href = a.getAttribute("href") || "";
        var active =
          (href === "/gh/index.html" && (path === "/" || path === "/gh/" || path === "/gh/index.html")) ||
          (href.length > 5 && href !== "/gh/index.html" && path.indexOf(href.replace("index.html", "")) === 0);
        if (active) a.classList.add("bb-active");
      });
    });
  }
  if (document.readyState !== "loading") markTabBar();
  document.addEventListener("DOMContentLoaded", markTabBar);
})();
