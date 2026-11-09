/**
 * Builds andondeck.com.
 *
 * Every key on the site is drawn by the plugin's own renderer, so the page
 * shows exactly what a deck shows and cannot drift from it. Run with
 * `npm run site`; the upload-ready result lands in `site/dist/`.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(here, "src");
const out = join(here, "dist");

const R = await import(join(root, ".test-build/ui/render.js"));
const { tile, alertScene, alertKey, strip } = R;

/** Raw SVG markup of a data URI the renderer produced. */
const svgOf = (uri) => Buffer.from(uri.split(",")[1], "base64").toString("utf8");

// ---------------------------------------------------------------------------
// Keys, configured the way the plugin's actions draw them.
// ---------------------------------------------------------------------------

const PHASES = 8;

/** A native Text key, drawn like the artwork the profiles ship. */
function typed(command, label) {
	const font = "'Segoe UI','DejaVu Sans',sans-serif";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><rect width="72" height="72" rx="9" fill="#201E1C"/><rect x="1" y="1" width="70" height="70" rx="8" fill="none" stroke="#B9B2A8" stroke-opacity=".55" stroke-width="2"/><text x="36" y="21" font-family="${font}" font-size="9" font-weight="600" fill="#948E86" text-anchor="middle">TYPES</text><text x="36" y="42" font-family="${font}" font-size="${Math.min(14, 58 / (0.72 * command.length)).toFixed(1)}" font-weight="700" fill="#F2EFEA" text-anchor="middle">${command}</text><text x="36" y="58" font-family="${font}" font-size="9" fill="#948E86" text-anchor="middle">${label}</text></svg>`;
}

const MOOD = { idle: "idle", working: "working", waiting: "waiting", error: "error", offline: "offline" };

function slot(index, session, phase) {
	if (!session) {
		return svgOf(tile({ tone: "offline", eyebrow: `Slot ${index}`, headline: "Empty", mascot: "offline" }));
	}
	const { status, project } = session;
	const edge = status === "working" ? "travel" : status === "waiting" ? "pulse" : status === "error" ? "broken" : "quiet";
	return svgOf(
		tile({
			family: "session",
			tone: status,
			edge,
			phase,
			eyebrow: project,
			headline: status === "waiting" ? "Waiting" : status === "working" ? "Working" : status === "error" ? "Failed" : "Idle",
			headlineTone: "state",
			mascot: MOOD[status],
		}),
	);
}

function approve(verdict, pending, phase) {
	const label = { allow: "Allow", always: "Always", deny: "Deny" }[verdict];
	if (!pending) {
		return svgOf(tile({ family: verdict, tone: "offline", headline: label, subtitle: "Nothing to answer" }));
	}
	return svgOf(
		tile({
			family: verdict,
			tone: verdict === "deny" ? "error" : verdict === "always" ? "accent" : "working",
			edge: "pulse",
			phase,
			eyebrow: `Bash  0:${String(41 - Math.round(phase * 4)).padStart(2, "0")}`,
			headline: label,
			headlineTone: "state",
			subtitle: verdict === "always" ? "Bash(npm test:*)" : "npm test",
			progress: 0.7,
		}),
	);
}

const queue = (label, queued, project = "shop") =>
	svgOf(tile({ family: "queue", tone: "accent", eyebrow: "Queue", headline: label, subtitle: project, badge: queued || undefined }));

const meter = (eyebrow, headline, subtitle, tone, progress, chart) =>
	svgOf(tile({ family: "meter", tone, eyebrow, headline, subtitle, progress, chart }));

const WEEK = [38e6, 61e6, 12e6, 0, 74e6, 55e6, 41e6];

/**
 * The XL layout the profiles ship, in one state.
 * @param s Scene state.
 * @param phase 0–1 animation position.
 * @returns 32 SVG strings, row by row.
 */
function xl(s, phase) {
	const pending = s.pending;
	const halt = svgOf(
		tile({
			family: "control",
			tone: s.status === "working" ? "error" : "offline",
			headline: "Stop",
			headlineTone: s.status === "working" ? "state" : "ink",
			subtitle: s.status === "working" ? (s.tool ?? "shop") : "Nothing running",
		}),
	);
	const auto = (scope) =>
		svgOf(
			tile({
				family: "control",
				ghost: "sleep",
				tone: "accent",
				eyebrow: "Autopilot",
				headline: scope === "all" ? "All tools" : "Read-only",
				subtitle: scope === "all" ? "off · 10 min" : "off · 15 min",
			}),
		);
	const five = s.fiveWarn
		? meter("5h limit", "78%", "full in 1h 20m", "waiting", 0.78)
		: meter("5h limit", `${s.five ?? 41}%`, "resets 2h 37m", "working", (s.five ?? 41) / 100);

	return [
		slot(1, { status: s.status, project: "shop" }, phase),
		slot(2, { status: "idle", project: "docs-site" }, phase),
		slot(3, null, phase),
		slot(4, null, phase),
		meter("Context", `${s.context ?? 34}%`, `${s.context ?? 34 * 2}k / 200k`, "idle", (s.context ?? 34) / 100),
		five,
		meter("Week limit", "23%", "resets 4d 6h", "working", 0.23),
		meter("7 days", "281M", "today 41M", "accent", undefined, { kind: "bars", series: WEEK }),

		approve("allow", pending, phase),
		approve("always", pending, phase),
		approve("deny", pending, phase),
		halt,
		auto("safe"),
		svgOf(tile({ family: "control", ghost: "stand", tone: "accent", eyebrow: "Model", headline: "Opus", subtitle: "shop" })),
		typed("/model", "Pick model"),
		typed("/context", "Context map"),

		queue("Run tests", s.queued),
		queue("Review", s.queued),
		queue("Commit", s.queued),
		queue("Docs", s.queued),
		svgOf(tile({ family: "queue", tone: "accent", eyebrow: "Queue clipboard", headline: "Clipboard", subtitle: "shop", badge: s.queued || undefined })),
		svgOf(tile({ family: "queue", tone: s.queued ? "accent" : "offline", eyebrow: "Queue", headline: "Next ↑", subtitle: s.queued ? "Run tests" : "Empty", badge: s.queued || undefined })),
		svgOf(tile({ family: "queue", tone: s.queued ? "accent" : "offline", eyebrow: "Queue", headline: "Drop next", subtitle: s.queued ? "Run tests" : "Empty", badge: s.queued || undefined })),
		svgOf(tile({ family: "queue", tone: s.queued ? "accent" : "offline", eyebrow: "Queue", headline: "Clear queue", subtitle: s.queued ? "Run tests" : "Empty", badge: s.queued || undefined })),

		svgOf(tile({ family: "launch", tone: "accent", eyebrow: "Launch", headline: "shop", subtitle: "Default model" })),
		svgOf(tile({ family: "launch", tone: "accent", eyebrow: "Launch", headline: "docs-site", subtitle: "Default model" })),
		svgOf(tile({ family: "launch", tone: "accent", eyebrow: "Task", headline: "Review diff", subtitle: "shop" })),
		svgOf(tile({ family: "launch", tone: "accent", eyebrow: "Task", headline: "Today", subtitle: "shop" })),
		typed("/compact", "Compact"),
		queue("Continue", s.queued),
		auto("all"),
		svgOf(tile({ family: "session", tone: "accent", eyebrow: "Andon Deck", headline: "Connected", subtitle: "hold for layout" })),
	];
}

/** The XL as the full-deck alert. */
function xlAlert(frame) {
	const scene = alertScene(8, 4, frame, "shop");
	return Array.from({ length: 32 }, (_, i) => svgOf(alertKey(scene, i % 8, Math.floor(i / 8))));
}

// Image table: identical keys are stored once and referenced by index.
const table = [];
const index = new Map();
function ref(svg) {
	let id = index.get(svg);
	if (id === undefined) {
		id = table.length;
		table.push(svg);
		index.set(svg, id);
	}
	return id;
}
const frames = (make, count = PHASES) => Array.from({ length: count }, (_, f) => make(f / count).map(ref));

/**
 * The demo: what a working session looks like on an XL, scene by scene.
 * `press` is the key a finger lands on; `caption` a key into the strings.
 */
const SCENES = [
	{ caption: "s1", ms: 3200, frames: frames(() => xl({ status: "idle" }), 1) },
	{ caption: "s2", ms: 4200, press: 0, frames: frames((p) => xl({ status: "working", tool: "Edit cart.ts", context: 41 }, p)) },
	{ caption: "s3", ms: 3800, press: 16, frames: frames((p) => xl({ status: "working", tool: "Edit cart.ts", context: 44, queued: 1 }, p)) },
	{ caption: "s4", ms: 4400, frames: frames((p) => xl({ status: "waiting", pending: true, context: 47, queued: 1 }, p)) },
	{ caption: "s5", ms: 4200, frames: [0, 1, 0, 1].map((f) => xlAlert(f).map(ref)), frameMs: 500 },
	{ caption: "s6", ms: 3800, press: 8, frames: frames((p) => xl({ status: "working", tool: "Bash npm test", context: 52, queued: 1 }, p)) },
	{ caption: "s7", ms: 4200, frames: frames((p) => xl({ status: "working", tool: "Run tests", context: 55 }, p)) },
	{ caption: "s8", ms: 4400, frames: frames((p) => xl({ status: "idle", context: 58, fiveWarn: true }, p), 1) },
];

/** Border legend: each motion on one key, animated. */
const LEGEND = [
	{ id: "travel", frames: frames((p) => [svgOf(tile({ family: "session", tone: "working", edge: "travel", phase: p, eyebrow: "shop", headline: "Working", headlineTone: "state", mascot: "working" }))]) },
	{ id: "pulse", frames: frames((p) => [svgOf(tile({ family: "session", tone: "waiting", edge: "pulse", phase: p, eyebrow: "shop", headline: "Waiting", headlineTone: "state", mascot: "waiting" }))]) },
	{ id: "broken", frames: frames(() => [svgOf(tile({ family: "session", tone: "error", edge: "broken", eyebrow: "shop", headline: "Failed", headlineTone: "state", mascot: "error" }))], 1) },
	{ id: "drift", frames: frames((p) => [svgOf(tile({ family: "session", tone: "compacting", edge: "drift", phase: p, eyebrow: "shop", headline: "Compacting", headlineTone: "state" }))]) },
	{ id: "quiet", frames: frames(() => [svgOf(tile({ family: "session", tone: "idle", eyebrow: "shop", headline: "Idle", headlineTone: "state", mascot: "idle" }))], 1) },
	{ id: "standby", frames: frames(() => [svgOf(tile({ family: "control", ghost: "sleep", tone: "error", edge: "standby", eyebrow: "Autopilot", headline: "All tools", subtitle: "press to switch" }))], 1) },
];

/** Alert section: the waving Clawd across a whole XL. */
const ALERT = [0, 1].map((f) => xlAlert(f).map(ref));

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const LANGS = [
	{ code: "en", dir: "", hreflang: "en", name: "English", locale: "en_US" },
	{ code: "de", dir: "de/", hreflang: "de", name: "Deutsch", locale: "de_DE" },
	{ code: "zh", dir: "zh/", hreflang: "zh-Hans", name: "简体中文", locale: "zh_CN" },
	{ code: "es", dir: "es/", hreflang: "es", name: "Español", locale: "es_ES" },
	{ code: "fr", dir: "fr/", hreflang: "fr", name: "Français", locale: "fr_FR" },
	{ code: "it", dir: "it/", hreflang: "it", name: "Italiano", locale: "it_IT" },
	{ code: "ru", dir: "ru/", hreflang: "ru", name: "Русский", locale: "ru_RU" },
];
const SITE = "https://andondeck.com/";

/**
 * Where every download button points. Fill in the Elgato Marketplace URL once
 * the listing is live; until then the buttons offer the GitHub release and a
 * note says the Marketplace listing is coming.
 */
const MARKETPLACE_URL = "";
const DOWNLOAD_URL = MARKETPLACE_URL || "https://github.com/make-mcp/andondeck/releases/latest";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Fills `{{key}}` (escaped) and `{{{key}}}` (trusted markup from the strings files). */
function fill(template, strings) {
	return template
		.replace(/\{\{\{(\w+)\}\}\}/g, (_, k) => {
			if (!(k in strings)) throw new Error(`missing string ${k}`);
			return strings[k];
		})
		.replace(/\{\{(\w+)\}\}/g, (_, k) => {
			if (!(k in strings)) throw new Error(`missing string ${k}`);
			return esc(strings[k]);
		});
}

/** Language links for one page, relative to where that page lives. */
function langLinks(current, up, file = "") {
	const menu = LANGS.map(
		(l) =>
			`<li role="none"><a role="menuitem" href="${up}${l.dir}${file}" hreflang="${l.hreflang}" lang="${l.hreflang}" data-lang="${l.code}"${l.code === current.code ? ' aria-current="page"' : ""}><span>${l.name}</span><span class="lang-code">${l.code.toUpperCase()}</span></a></li>`,
	).join("");
	const foot = LANGS.map(
		(l) => `<a href="${up}${l.dir}${file}" hreflang="${l.hreflang}" lang="${l.hreflang}" data-lang="${l.code}"${l.code === current.code ? ' aria-current="page"' : ""}>${l.name}</a>`,
	).join(" · ");
	const alternates = LANGS.map((l) => `<link rel="alternate" hreflang="${l.hreflang}" href="${SITE}${l.dir}${file}">`).join("\n") + `\n<link rel="alternate" hreflang="x-default" href="${SITE}${file}">`;
	return { menu, foot, alternates };
}

/** Legal page file name per language: German is the binding original. */
const legalFile = (kind, code) => (code === "de" ? `${kind}.html` : `${kind}.${code}.html`);

/** Devices section: the grid each device has, drawn from data. */
const DEVICES = [
	["Stream Deck", 5, 3, ""],
	["Stream Deck Mini", 3, 2, ""],
	["Stream Deck XL", 8, 4, ""],
	["Stream Deck +", 4, 2, "4"],
	["Stream Deck + XL", 9, 4, "6"],
	["Stream Deck Neo", 4, 2, ""],
	["Stream Deck Studio", 16, 2, "2"],
	["Stream Deck Pedal", 3, 1, "pedal"],
	["Stream Deck Mobile", 5, 3, ""],
	["Virtual Stream Deck", 4, 4, "virtual"],
	["Galleon 100 SD", 3, 4, "2"],
];

function devicesMarkup(t) {
	return DEVICES.map(([name, c, r, extra]) => {
		const cells = Array.from({ length: c * r }, () => "<i></i>").join("");
		const dials = /^\d+$/.test(extra) ? `<span class="dials">${"<b></b>".repeat(Number(extra))}</span>` : "";
		const note = extra === "pedal" ? t.devPedal : extra === "virtual" ? t.devVirtual : /^\d+$/.test(extra) ? `${c} × ${r} · ${extra} ${t.devDials}` : `${c} × ${r}`;
		return `<li class="device${extra === "pedal" ? " is-pedal" : ""}"><span class="grid cols-${c}">${cells}</span>${dials}<b>${esc(name)}</b><span>${esc(note)}</span></li>`;
	}).join("\n");
}

async function build() {
	await rm(out, { recursive: true, force: true });
	await mkdir(join(out, "assets"), { recursive: true });

	// Demo data: one image table, scenes and legend as indices into it.
	const demo = { images: table, scenes: SCENES, legend: LEGEND, alert: ALERT };
	const demoJson = JSON.stringify(demo);
	// A script rather than JSON: it loads under file:// too, where fetch() is
	// blocked, and the CSP allows it as a same-origin script.
	await writeFile(join(out, "assets/demo.js"), `window.ANDON_DEMO=${demoJson};\n`);

	// Static images: OG card, the dial strip, the marketplace icon.
	const og = await ogImage();
	await writeFile(join(out, "assets/og.png"), og);
	const dial = svgOf(strip({ title: "5h limit", value: "78%", subtitle: "full in 1h 20m", tone: "waiting", chart: { kind: "line", max: 100, series: [4, 6, 9, 14, 18, 22, 27, 33, 41, 47, 52, 58, 63, 69, 74, 78] } }));
	await writeFile(join(out, "assets/dial-plan.svg"), dial);
	const dialWeek = svgOf(strip({ title: "7 days", value: "281M", subtitle: "today 41M", tone: "accent", chart: { kind: "bars", series: WEEK } }));
	await writeFile(join(out, "assets/dial-week.svg"), dialWeek);
	await cp(join(root, "com.andondeck.plugin.sdPlugin/imgs/plugin/marketplace@2x.png"), join(out, "assets/icon.png"));

	// Static files, with a content hash for cache busting.
	const hashes = {};
	for (const name of ["style.css", "main.js", "lang.js", "favicon.svg"]) {
		const data = await readFile(join(src, name));
		hashes[name] = createHash("sha1").update(data).digest("hex").slice(0, 10);
		await writeFile(join(out, name), data);
	}
	hashes.demo = createHash("sha1").update(demoJson).digest("hex").slice(0, 10);

	const template = await readFile(join(src, "index.html"), "utf8");
	const legalTemplate = await readFile(join(src, "legal.html"), "utf8");
	const strings = {};
	for (const lang of LANGS) {
		strings[lang.code] = JSON.parse(await readFile(join(src, "i18n", `${lang.code}.json`), "utf8"));
	}
	const keys = Object.keys(strings.en);
	for (const lang of LANGS) {
		const missing = keys.filter((k) => !(k in strings[lang.code]));
		if (missing.length) throw new Error(`${lang.code} is missing ${missing.join(", ")}`);
	}

	for (const lang of LANGS) {
		const t = strings[lang.code];
		const up = lang.dir ? "../" : "";
		const links = langLinks(lang, up);
		const page = fill(template, {
			...t,
			lang: lang.hreflang,
			langCode: lang.code,
			langUpper: lang.code.toUpperCase(),
			root: lang.dir ? "" : ' data-root="1"',
			up,
			canonical: `${SITE}${lang.dir}`,
			locale: lang.locale,
			alternates: links.alternates,
			langMenu: links.menu,
			langFoot: links.foot,
			impressum: `${up}${legalFile("impressum", lang.code)}`,
			datenschutz: `${up}${legalFile("datenschutz", lang.code)}`,
			devices: devicesMarkup(t),
			downloadUrl: DOWNLOAD_URL,
			marketplaceNote: MARKETPLACE_URL ? "" : `      <span class="hint">${esc(t.marketplace)}</span>`,
			vCss: hashes["style.css"],
			vJs: hashes["main.js"],
			vLang: hashes["lang.js"],
			vDemo: hashes.demo,
		});
		await mkdir(join(out, lang.dir), { recursive: true });
		await writeFile(join(out, lang.dir, "index.html"), page);

		for (const kind of ["impressum", "datenschutz"]) {
			const file = legalFile(kind, lang.code);
			const legalLinks = LANGS.map(
				(l) => `<a href="${legalFile(kind, l.code)}" hreflang="${l.hreflang}" lang="${l.hreflang}"${l.code === lang.code ? ' aria-current="true"' : ""}>${l.name}</a>`,
			).join(" · ");
			const html = fill(legalTemplate, {
				...t,
				lang: lang.hreflang,
				title: kind === "impressum" ? t.legalNotice : t.privacy,
				body: (await readFile(join(src, "legal", lang.code, `${kind}.html`), "utf8")).trim(),
				legalLangs: legalLinks,
				home: `${lang.dir || "./"}`,
				impressum: legalFile("impressum", lang.code),
				datenschutz: legalFile("datenschutz", lang.code),
				vCss: hashes["style.css"],
			});
			await writeFile(join(out, file), html);
		}
	}

	await writeFile(join(out, ".htaccess"), await readFile(join(src, "htaccess")));
	await writeFile(join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n`);
	await writeFile(
		join(out, "sitemap.xml"),
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${LANGS.map((l) => `<url><loc>${SITE}${l.dir}</loc></url>`).join("\n")}\n</urlset>\n`,
	);

	const files = await readdir(out, { recursive: true });
	console.log(`site: ${files.length} files, ${table.length} unique key images, demo ${(demoJson.length / 1024).toFixed(0)} KiB`);
}

/** Social preview: the XL mid-turn, beside the name. */
async function ogImage() {
	const keys = xl({ status: "waiting", pending: true, context: 47, queued: 1 }, 0.3);
	const K = 62;
	const G = 9;
	const deckW = 8 * K + 7 * G + 40;
	const deckH = 4 * K + 3 * G + 40;
	const x0 = 1200 - deckW - 50;
	const y0 = (630 - deckH) / 2;
	const parts = await Promise.all(
		keys.map(async (svg, i) => ({
			input: await sharp(Buffer.from(svg), { density: 200 }).resize(K, K).png().toBuffer(),
			left: x0 + 20 + (i % 8) * (K + G),
			top: Math.round(y0 + 20 + Math.floor(i / 8) * (K + G)),
		})),
	);
	const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#141413"/><rect x="${x0}" y="${y0}" width="${deckW}" height="${deckH}" rx="26" fill="#0b0b0a" stroke="#3a3833"/><circle cx="70" cy="96" r="9" fill="#4C9A6A"/><circle cx="98" cy="96" r="9" fill="#E8A33D"/><circle cx="126" cy="96" r="9" fill="#D1483F" opacity=".35"/><text x="60" y="190" font-family="DejaVu Sans Mono, monospace" font-size="54" font-weight="700" fill="#f0eee6">Andon Deck</text><text x="60" y="240" font-family="DejaVu Sans Mono, monospace" font-size="26" fill="#a8a49a">for Claude Code</text><text x="60" y="470" font-family="DejaVu Sans Mono, monospace" font-size="21" fill="#a8a49a">Claude's state on every key.</text><text x="60" y="504" font-family="DejaVu Sans Mono, monospace" font-size="21" fill="#a8a49a">Approve, queue, watch limits.</text><text x="60" y="560" font-family="DejaVu Sans Mono, monospace" font-size="18" fill="#75716a">andondeck.com · free · open source</text></svg>`;
	return sharp(Buffer.from(bg)).composite(parts).png().toBuffer();
}

await build();
