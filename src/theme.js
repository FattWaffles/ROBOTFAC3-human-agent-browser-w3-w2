// Applies the saved theme before the first paint, so a light window never flashes dark. Dark is the default.
// A classic script on purpose: main.js is a module, and a module runs after the page has been drawn once.
try {
  if (localStorage.getItem("rf3.theme") === "light") document.documentElement.dataset.theme = "light";
} catch { /* storage is blocked: the dark default applies */ }
