"use strict";
// Picks the color theme before the page paints, so there's no flash of the wrong one.
// Loaded in <head>. A saved choice (see site.ts) wins; otherwise follow the device setting.
(function () {
    let saved = null;
    try {
        saved = localStorage.getItem("gc-theme");
    }
    catch (_) { /* storage unavailable */ }
    const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
