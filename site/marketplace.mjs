/**
 * Elgato Marketplace media: icon (288 × 288), thumbnail and gallery
 * (1920 × 960 each), every key drawn by the plugin's own renderer.
 *
 * Run with `npm run marketplace`; the images land in `site/marketplace/`.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { WEEK, alertKey, alertScene, strip, svgOf, tile, xl } from "./scenes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "marketplace");
const W = 1920;
const H = 960;
const MONO = "DejaVu Sans Mono, Menlo, Consolas, monospace";
const C = { bg: "#141413", body: "#0c0c0b", line: "#3a3833", fg: "#f0eee6", muted: "#a8a49a", dim: "#75716a", amber: "#e8a33d", green: "#4c9a6a", red: "#d1483f" };

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const png = (svg, size) => sharp(Buffer.from(svg), { density: 300 }).resize(size, size).png().toBuffer();

/**
 * A deck: dark body, keys in a grid.
 * @returns composite parts and the body's size.
 */
async function deck(keys, columns, rows, x, y, key, gap) {
	const pad = Math.round(key * 0.28);
	const w = columns * key + (columns - 1) * gap + pad * 2;
	const h = rows * key + (rows - 1) * gap + pad * 2;
	const parts = await Promise.all(
		keys.map(async (svg, i) => ({
			input: await png(svg, key),
			left: Math.round(x + pad + (i % columns) * (key + gap)),
			top: Math.round(y + pad + Math.floor(i / columns) * (key + gap)),
		})),
	);
	const body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.round(pad * 0.9)}" fill="${C.body}" stroke="${C.line}" stroke-width="2"/>`;
	return { parts, body, w, h };
}

/** Background, glow and a headline at the top. */
function frame(title, sub, glow = C.amber, extra = "") {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
		<defs><radialGradient id="g" cx="50%" cy="62%" r="60%"><stop offset="0" stop-color="${glow}" stop-opacity=".16"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient></defs>
		<rect width="${W}" height="${H}" fill="${C.bg}"/><rect width="${W}" height="${H}" fill="url(#g)"/>
		${title ? `<text x="${W / 2}" y="96" font-family="${MONO}" font-size="50" font-weight="700" fill="${C.fg}" text-anchor="middle">${esc(title)}</text>` : ""}
		${sub ? `<text x="${W / 2}" y="146" font-family="${MONO}" font-size="26" fill="${C.muted}" text-anchor="middle">${esc(sub)}</text>` : ""}
		${extra}
	</svg>`;
}

async function compose(name, svgBack, parts) {
	await sharp(Buffer.from(svgBack)).composite(parts).png().toFile(join(out, name));
	console.log(`marketplace: ${name}`);
}

/** The lights of the logo. */
const lights = (x, y, r) =>
	`<circle cx="${x}" cy="${y}" r="${r}" fill="${C.green}"/><circle cx="${x + r * 3}" cy="${y}" r="${r}" fill="${C.amber}"/><circle cx="${x + r * 6}" cy="${y}" r="${r}" fill="${C.red}" opacity=".35"/>`;

async function thumbnail() {
	const keys = xl({ status: "waiting", pending: true, context: 47, queued: 1 }, 0.3);
	const d = await deck(keys, 8, 4, 0, 0, 118, 14);
	const x = W - d.w - 80;
	const y = (H - d.h) / 2;
	const placed = await deck(keys, 8, 4, x, y, 118, 14);
	const text = `
		${lights(110, 250, 15)}
		<text x="92" y="380" font-family="${MONO}" font-size="92" font-weight="700" fill="${C.fg}">Andon Deck</text>
		<text x="96" y="446" font-family="${MONO}" font-size="40" fill="${C.amber}">for Claude Code</text>
		<text x="96" y="580" font-family="${MONO}" font-size="28" fill="${C.muted}">Claude's state on every key.</text>
		<text x="96" y="624" font-family="${MONO}" font-size="28" fill="${C.muted}">Approve, queue, watch limits.</text>
		<text x="96" y="760" font-family="${MONO}" font-size="22" fill="${C.dim}">free · open source · local</text>
		${placed.body}`;
	await compose("thumbnail.png", frame("", "", C.amber, text), placed.parts);
}

async function gallery() {
	// 1 — the deck mid-turn
	{
		const keys = xl({ status: "working", tool: "Edit cart.ts", context: 44, queued: 1 }, 0.35);
		const key = 148;
		const probe = await deck(keys, 8, 4, 0, 0, key, 16);
		const d = await deck(keys, 8, 4, (W - probe.w) / 2, 200, key, 16);
		await compose("gallery-1-deck.png", frame("Claude's state on every key", "sessions · answers · queue · limits — the Stream Deck XL layout", C.green, d.body), d.parts);
	}

	// 2 — the full-deck alert. Drawn as one picture with the key gaps laid over
	// it as thin bars: spaced-out keys would split the words and show a cut
	// letter twice, which reads worse than the real deck does at arm's length.
	{
		const cols = 8;
		const rows = 4;
		const key = 148;
		const bar = 10;
		const w = cols * key;
		const h = rows * key;
		const pad = 40;
		const x = (W - w) / 2;
		const y = 236;
		const scene = alertScene(cols, rows, 0, "shop");
		const picture = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${cols * 72} ${rows * 72}">${scene}</svg>`), { density: 200 }).resize(w, h).png().toBuffer();
		const bars = [
			...Array.from({ length: cols - 1 }, (_, i) => `<rect x="${x + (i + 1) * key - bar / 2}" y="${y}" width="${bar}" height="${h}" fill="${C.body}"/>`),
			...Array.from({ length: rows - 1 }, (_, i) => `<rect x="${x}" y="${y + (i + 1) * key - bar / 2}" width="${w}" height="${bar}" fill="${C.body}"/>`),
		].join("");
		const back = frame("When Claude needs you, the whole deck says so", "from any profile · any key takes you back", C.amber,
			`<rect x="${x - pad}" y="${y - pad}" width="${w + pad * 2}" height="${h + pad * 2}" rx="34" fill="${C.body}" stroke="${C.line}" stroke-width="2"/>`);
		const withPicture = await sharp(Buffer.from(back)).composite([{ input: picture, left: Math.round(x), top: y }]).png().toBuffer();
		await sharp(withPicture)
			.composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${bars}</svg>`), left: 0, top: 0 }])
			.png()
			.toFile(join(out, "gallery-2-alert.png"));
		console.log("marketplace: gallery-2-alert.png");
	}

	// 3 — the border legend
	{
		const keys = [
			[tile({ family: "session", tone: "working", edge: "travel", phase: 0.15, eyebrow: "shop", headline: "Working", headlineTone: "state", mascot: "working" }), "working", "light runs the edge"],
			[tile({ family: "session", tone: "waiting", edge: "pulse", phase: 0.25, eyebrow: "shop", headline: "Waiting", headlineTone: "state", mascot: "waiting" }), "waiting for you", "the edge breathes"],
			[tile({ family: "session", tone: "error", edge: "broken", eyebrow: "shop", headline: "Failed", headlineTone: "state", mascot: "error" }), "failed", "a ring with a gap"],
			[tile({ family: "session", tone: "compacting", edge: "drift", phase: 0.3, eyebrow: "shop", headline: "Compacting", headlineTone: "state" }), "compacting", "dashes drift"],
			[tile({ family: "session", tone: "idle", eyebrow: "shop", headline: "Idle", headlineTone: "state", mascot: "idle" }), "idle", "thin and still"],
		];
		const key = 250;
		const gap = 70;
		const total = keys.length * key + (keys.length - 1) * gap;
		const x0 = (W - total) / 2;
		const parts = await Promise.all(keys.map(async ([uri], i) => ({ input: await png(svgOf(uri), key), left: Math.round(x0 + i * (key + gap)), top: 330 })));
		const labels = keys
			.map(([, a, b], i) => {
				const cx = x0 + i * (key + gap) + key / 2;
				return `<text x="${cx}" y="660" font-family="${MONO}" font-size="28" font-weight="700" fill="${C.fg}" text-anchor="middle">${a}</text><text x="${cx}" y="702" font-family="${MONO}" font-size="22" fill="${C.muted}" text-anchor="middle">${b}</text>`;
			})
			.join("");
		await compose("gallery-3-border.png", frame("The border is the signal", "readable from across the room, out of the corner of your eye", C.amber, labels), parts);
	}

	// 4 — limits and history
	{
		const keys = [
			svgOf(tile({ family: "meter", tone: "waiting", eyebrow: "5h limit", headline: "78%", subtitle: "full in 1h 20m", progress: 0.78 })),
			svgOf(tile({ family: "meter", tone: "working", eyebrow: "Week limit", headline: "23%", subtitle: "resets 4d 6h", progress: 0.23 })),
			svgOf(tile({ family: "meter", tone: "accent", eyebrow: "7 days", headline: "281M", chart: { kind: "bars", series: WEEK } })),
			svgOf(tile({ family: "meter", tone: "accent", eyebrow: "Today", headline: "41M", chart: { kind: "bars", series: [0, 2e6, 6e6, 9e6, 1e6, 0, 0, 3e6, 8e6, 7e6, 4e6, 1e6] } })),
		];
		const key = 230;
		const gap = 40;
		const totalKeys = keys.length * key + (keys.length - 1) * gap;
		const xk = (W - totalKeys) / 2;
		const parts = await Promise.all(keys.map(async (svg, i) => ({ input: await png(svg, key), left: Math.round(xk + i * (key + gap)), top: 220 })));
		const strips = [
			svgOf(strip({ title: "5h limit", value: "78%", subtitle: "full in 1h 20m", tone: "waiting", chart: { kind: "line", max: 100, series: [4, 6, 9, 14, 18, 22, 27, 33, 41, 47, 52, 58, 63, 69, 74, 78] } })),
			svgOf(strip({ title: "7 days", value: "281M", subtitle: "today 41M", tone: "accent", chart: { kind: "bars", series: WEEK } })),
		];
		const sw = 480;
		const sh = 240;
		const xs = (W - (2 * sw + 60)) / 2;
		for (const [i, svg] of strips.entries()) {
			parts.push({ input: await sharp(Buffer.from(svg), { density: 300 }).resize(sw, sh).png().toBuffer(), left: Math.round(xs + i * (sw + 60)), top: 560 });
		}
		const note = `<text x="${W / 2}" y="870" font-family="${MONO}" font-size="24" fill="${C.dim}" text-anchor="middle">keys above · Stream Deck + dials below</text>`;
		await compose("gallery-4-limits.png", frame("Plan limits that look ahead", "warns before the 5-hour window runs out · a week of usage from your transcripts", C.amber, note), parts);
	}

	// 5 — layouts for every deck
	{
		const k = xl({ status: "working", tool: "Edit cart.ts", context: 44 }, 0.35);
		const K = { slot: k[0], context: k[4], plan: k[5], allow: k[8], always: k[9], deny: k[10], halt: k[11], auto: k[12], model: k[13], tests: k[16], clear: k[23], launch: k[24], compact: k[28], setup: k[31] };
		const layouts = [
			{ name: "Stream Deck Mini", c: 3, r: 2, keys: [K.slot, K.allow, K.deny, K.halt, K.tests, K.setup] },
			{ name: "Stream Deck Neo", c: 4, r: 2, keys: [K.slot, K.allow, K.deny, K.halt, K.tests, K.compact, K.auto, K.setup] },
			{ name: "Stream Deck", c: 5, r: 3, keys: [K.slot, k[1], k[2], K.context, K.plan, K.allow, K.deny, K.halt, K.auto, K.model, K.tests, K.clear, K.launch, K.compact, K.setup] },
		];
		const key = 104;
		const gap = 12;
		const space = 110;
		const placed = [];
		const sizes = await Promise.all(layouts.map((l) => deck(l.keys, l.c, l.r, 0, 0, key, gap)));
		let x = (W - sizes.reduce((sum, d) => sum + d.w, 0) - space * (layouts.length - 1)) / 2;
		const bodies = [];
		const labels = [];
		for (const l of layouts) {
			const probe = await deck(l.keys, l.c, l.r, 0, 0, key, gap);
			const y = 260 + (420 - probe.h) / 2;
			const d = await deck(l.keys, l.c, l.r, x, y, key, gap);
			placed.push(...d.parts);
			bodies.push(d.body);
			labels.push(`<text x="${x + d.w / 2}" y="${y + d.h + 56}" font-family="${MONO}" font-size="26" font-weight="700" fill="${C.fg}" text-anchor="middle">${l.name}</text><text x="${x + d.w / 2}" y="${y + d.h + 92}" font-family="${MONO}" font-size="21" fill="${C.muted}" text-anchor="middle">${l.c} × ${l.r}</text>`);
			x += d.w + space;
		}
		const more = `<text x="${W / 2}" y="880" font-family="${MONO}" font-size="24" fill="${C.dim}" text-anchor="middle">also XL · + · + XL · Studio · Pedal · Mobile · Virtual · Galleon 100 SD — eleven devices in all</text>`;
		await compose("gallery-5-layouts.png", frame("A ready-made layout for every Stream Deck", "built for each grid, not cropped from a bigger one", C.green, bodies.join("") + labels.join("") + more), placed);
	}
}

await mkdir(out, { recursive: true });
await copyFile(join(here, "../com.andondeck.plugin.sdPlugin/imgs/plugin/marketplace.png"), join(out, "icon.png"));
console.log("marketplace: icon.png");
await thumbnail();
await gallery();
