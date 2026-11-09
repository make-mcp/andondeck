// Runs in <head> of the English page at "/": go to the language the visitor chose before.
(function () {
  var root = document.documentElement;
  if (root.getAttribute("data-root") !== "1") return;
  var langs = ["de", "zh", "es", "fr", "it", "ru"];
  var saved = "";
  try { saved = localStorage.getItem("andon-deck-lang") || ""; } catch (e) {}
  if (langs.indexOf(saved) >= 0) location.replace(saved + "/" + location.hash);
})();
