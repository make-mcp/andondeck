"use strict";

// Keys come pre-rendered by the plugin's own renderer (see site/build.mjs);
// this file only decides which image each key shows when.

const LANG = document.body.dataset.lang || "en";
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
document.documentElement.classList.add("js");

const uri = (svg) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

/** Fills a grid with <img> keys and returns a painter for frames of indices. */
function deckPainter(el, count, images) {
  const keys = Array.from({ length: count }, () => {
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    el.appendChild(img);
    return img;
  });
  const shown = new Array(count).fill(-1);
  return {
    keys,
    paint(frame) {
      frame.forEach((id, i) => {
        if (shown[i] !== id) {
          shown[i] = id;
          keys[i].src = images[id];
        }
      });
    },
  };
}

async function start() {
  const deckEl = document.getElementById("deck");
  if (!deckEl) return;
  const data = window.ANDON_DEMO;
  if (!data) return;
  const images = data.images.map(uri);

  // ---- the demo deck ---------------------------------------------------
  const deck = deckPainter(deckEl, 32, images);
  const caption = document.getElementById("caption");
  const steps = [...document.querySelectorAll("#steps li")];
  let run = 0;
  let visible = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function play() {
    const me = ++run;
    steps.forEach((s) => s.classList.remove("done", "now"));
    for (let n = 0; n < data.scenes.length; n++) {
      const scene = data.scenes[n];
      if (me !== run) return;
      caption.textContent = caption.dataset[scene.caption] || "";
      steps.forEach((s, i) => s.classList.toggle("done", i < n));
      steps.forEach((s, i) => s.classList.toggle("now", i === n));
      steps[n]?.style.setProperty("--ms", `${scene.ms}ms`);

      if (scene.press !== undefined) {
        deck.paint(data.scenes[Math.max(0, n - 1)].frames.at(-1));
        deck.keys[scene.press].classList.add("pressed");
        await sleep(260);
        deck.keys[scene.press].classList.remove("pressed");
      }

      const frameMs = scene.frameMs || 2000 / scene.frames.length;
      const until = performance.now() + scene.ms;
      let f = 0;
      while (performance.now() < until) {
        if (me !== run) return;
        if (visible) deck.paint(scene.frames[f % scene.frames.length]);
        f++;
        await sleep(reduced ? scene.ms : Math.max(120, frameMs));
      }
    }
    steps.forEach((s) => s.classList.replace("now", "done"));
    await sleep(1600);
    if (me === run && !reduced) play();
  }

  document.getElementById("replay")?.addEventListener("click", () => play());

  // Pause painting while the deck is off screen; the script keeps its place.
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
    }).observe(deckEl);
  }
  play();

  // ---- legend keys ----------------------------------------------------
  const legend = Object.fromEntries(data.legend.map((l) => [l.id, l.frames]));
  const legendKeys = [...document.querySelectorAll("[data-legend]")];
  let tick = 0;
  const paintLegend = () => {
    for (const img of legendKeys) {
      const frames = legend[img.dataset.legend];
      if (!frames) continue;
      const next = images[frames[tick % frames.length][0]];
      if (img.src !== next) img.src = next;
    }
    tick++;
  };
  paintLegend();
  if (!reduced) setInterval(paintLegend, 250);

  // ---- alert deck -----------------------------------------------------
  const alertEl = document.getElementById("alert-deck");
  if (alertEl) {
    const alertDeck = deckPainter(alertEl, 32, images);
    let a = 0;
    alertDeck.paint(data.alert[0]);
    if (!reduced) setInterval(() => alertDeck.paint(data.alert[++a % data.alert.length]), 500);
  }
}
start();

// ---- reveal on scroll ----------------------------------------------------
(function reveal() {
  const items = document.querySelectorAll(".card, .legend li, .device, .steps li, .checks li, blockquote");
  if (!("IntersectionObserver" in window) || reduced) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    }
  }, { rootMargin: "0px 0px -8% 0px" });
  items.forEach((el) => {
    el.classList.add("reveal");
    io.observe(el);
  });
})();

// ---- language: remember a choice made from the menu or the footer --------
document.querySelectorAll("a[data-lang]").forEach((link) => {
  link.addEventListener("click", () => store.set("andon-deck-lang", link.dataset.lang));
});

// Language menu: button + menu list; Escape, outside click and arrow keys behave like a native menu.
(function langMenu() {
  const button = document.querySelector(".lang-btn");
  const list = document.getElementById("lang-list");
  if (!button || !list) return;
  const items = () => [...list.querySelectorAll("a")];
  const open = (focus) => {
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    if (focus) (items().find((a) => a.hasAttribute("aria-current")) || items()[0]).focus();
  };
  const close = (refocus) => {
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (refocus) button.focus();
  };
  button.addEventListener("click", () => (list.hidden ? open(false) : close(false)));
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(true);
    }
  });
  list.addEventListener("keydown", (e) => {
    const all = items();
    const i = all.indexOf(document.activeElement);
    if (e.key === "Escape") return close(true);
    if (e.key === "Tab") return close(false);
    const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    all[(next + all.length) % all.length].focus();
  });
  document.addEventListener("click", (e) => {
    if (!list.hidden && !e.target.closest(".lang-menu")) close(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !list.hidden) close(true);
  });
})();

// First visit to the English page with a browser that prefers one of our other languages: offer it once.
const HINTS = {
  de: ["Diese Seite gibt es auch auf Deutsch.", "Auf Deutsch lesen", "Nein, danke"],
  zh: ["本页面也有简体中文版。", "阅读中文版", "不用了"],
  es: ["Esta página también está en español.", "Leer en español", "No, gracias"],
  fr: ["Cette page existe aussi en français.", "Lire en français", "Non merci"],
  it: ["Questa pagina è disponibile anche in italiano.", "Leggi in italiano", "No, grazie"],
  ru: ["Эта страница есть и на русском.", "Читать на русском", "Нет, спасибо"],
};
(function langHint() {
  const box = document.getElementById("lang-hint");
  if (!box || LANG !== "en" || store.get("andon-deck-lang")) return;
  const wanted = (navigator.languages || [navigator.language]).map((l) => String(l).toLowerCase().split("-")[0]);
  const code = wanted.find((l) => HINTS[l]);
  if (!code || wanted[0] === "en") return;
  const [text, yes, no] = HINTS[code];
  const msg = document.createElement("span");
  msg.lang = code;
  msg.textContent = text;
  const go = document.createElement("a");
  go.href = `${code}/`;
  go.textContent = yes;
  go.lang = code;
  go.addEventListener("click", () => store.set("andon-deck-lang", code));
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = no;
  dismiss.lang = code;
  dismiss.addEventListener("click", () => {
    store.set("andon-deck-lang", "en");
    box.hidden = true;
  });
  const actions = document.createElement("div");
  actions.className = "lang-hint-actions";
  actions.append(go, dismiss);
  box.append(msg, actions);
  box.hidden = false;
})();
