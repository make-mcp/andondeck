/**
 * Renders every PNG the manifest references from inline SVG.
 *
 * Keeping the artwork as code means the whole icon set stays consistent and
 * regenerates on `npm run build` instead of living as binary blobs in git.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "io.github.claude-deck.plugin.sdPlugin", "imgs");

const ACCENT = "#B9B2A8";
const INK = "#F2EFEA";
const BACKDROP = "#201E1C";

const FONT = "'Segoe UI','DejaVu Sans',sans-serif";

/** A glyph centred on a transparent square — used for the action list icons. */
function listIcon(glyph) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
		<text x="10" y="15" font-family="${FONT}" font-size="15" font-weight="700" fill="${INK}" text-anchor="middle">${glyph}</text>
	</svg>`;
}

/** A full key tile, matching what the plugin draws at runtime. */
function keyTile({ glyph, title, tone = ACCENT, solid = false }) {
	const background = solid ? tone : BACKDROP;
	const ink = solid ? "#1b1210" : INK;

	return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
		<rect width="72" height="72" rx="9" fill="${background}"/>
		${solid ? "" : `<rect width="72" height="3" fill="${tone}"/>`}
		<text x="36" y="40" font-family="${FONT}" font-size="26" font-weight="700" fill="${solid ? ink : tone}" text-anchor="middle">${glyph}</text>
		<text x="36" y="58" font-family="${FONT}" font-size="11" font-weight="600" fill="${ink}" text-anchor="middle">${title}</text>
	</svg>`;
}

/** Clawd, from the pixel map Claude Code ships, as crisp SVG cells. */
const CLAWD_ROWS = [
	"..CCCCCCCCCCCCC..",
	"..CCCCCCCCCCCCC..",
	"..CCCECCCCCECCC..",
	"..CCCECCCCCECCC..",
	"CCCCCCCCCCCCCCCCC",
	"CCCCCCCCCCCCCCCCC",
	"..CCCCCCCCCCCCC..",
	"..CCCCCCCCCCCCC..",
	"..C.C.......C.C..",
	"..C.C.......C.C..",
];

function clawd(x0, y0, cell, body = "#D77757", eye = "#14110F") {
	let out = "";
	CLAWD_ROWS.forEach((row, y) =>
		[...row].forEach((ch, x) => {
			if (ch !== ".") {
				out += `<rect x="${x0 + x * cell}" y="${y0 + y * cell}" width="${cell}" height="${cell}" fill="${ch === "E" ? eye : body}"/>`;
			}
		}),
	);
	return `<g shape-rendering="crispEdges">${out}</g>`;
}

/** The Marketplace tile: Clawd above the wordmark. */
function marketplaceIcon() {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="288" height="288" viewBox="0 0 288 288">
		<rect width="288" height="288" rx="64" fill="${BACKDROP}"/>
		${clawd(144 - 17 * 6, 56, 12)}
		<text x="144" y="228" font-family="${FONT}" font-size="34" font-weight="700" fill="${INK}" text-anchor="middle">Andon Deck</text>
	</svg>`;
}

/** Category icon in the action list: Clawd in white, as Stream Deck expects. */
function categoryIcon() {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="28" viewBox="0 0 34 28">
		${clawd(0, 4, 2, INK, "rgba(0,0,0,0)")}
	</svg>`;
}

/**
 * Writes an SVG as a PNG at 1x and 2x.
 * @param svg Source markup.
 * @param target Path without extension, relative to the images directory.
 * @param size Base width/height in pixels.
 */
async function emit(svg, target, size) {
	const file = join(out, target);
	await mkdir(dirname(file), { recursive: true });

	const buffer = Buffer.from(svg);
	await sharp(buffer, { density: 384 }).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(`${file}.png`);
	await sharp(buffer, { density: 768 }).resize(size * 2, size * 2, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(`${file}@2x.png`);
}

const ACTIONS = [
	{ dir: "status", glyph: "●", states: [{ name: "idle", glyph: "●", title: "Status" }] },
	{ dir: "queue", glyph: "+", states: [{ name: "key", glyph: "+", title: "Queue" }] },
	{ dir: "queue-control", glyph: "≡", states: [{ name: "key", glyph: "≡", title: "Queue" }] },
	{
		dir: "approve",
		glyph: "✓",
		states: [
			{ name: "allow", glyph: "✓", title: "Allow", tone: "#4C9A6A" },
			{ name: "deny", glyph: "✕", title: "Deny", tone: "#D1483F" },
		],
	},
	{ dir: "prompt", glyph: "✎", states: [{ name: "key", glyph: "✎", title: "Prompt" }] },
	{ dir: "session", glyph: "⇄", states: [{ name: "key", glyph: "⇄", title: "Session" }] },
	{
		dir: "headless",
		glyph: "⚡",
		states: [
			{ name: "key", glyph: "⚡", title: "Task" },
			{ name: "running", glyph: "▶", title: "Running", tone: "#E8A33D" },
		],
	},
	{ dir: "usage", glyph: "◷", states: [{ name: "key", glyph: "◷", title: "Usage" }] },
	{
		dir: "autopilot",
		glyph: "◎",
		states: [
			{ name: "off", glyph: "◎", title: "Autopilot", tone: "#46423E" },
			{ name: "on", glyph: "◉", title: "Armed", tone: "#E8A33D" },
		],
	},
	{
		dir: "halt",
		glyph: "■",
		states: [
			{ name: "key", glyph: "■", title: "Stop", tone: "#D1483F" },
			{ name: "stopped", glyph: "■", title: "Stopped", tone: "#D1483F" },
		],
	},
	{ dir: "model", glyph: "◆", states: [{ name: "key", glyph: "◆", title: "Model" }] },
	{ dir: "slot", glyph: "▦", states: [{ name: "key", glyph: "▦", title: "Session" }] },
	{ dir: "launch", glyph: "▸", states: [{ name: "key", glyph: "▸", title: "Launch" }] },
	{
		dir: "setup",
		glyph: "⚯",
		states: [
			{ name: "disconnected", glyph: "⚯", title: "Connect", tone: "#46423E" },
			{ name: "connected", glyph: "✓", title: "Connected", tone: "#4C9A6A" },
		],
	},
];

await emit(marketplaceIcon(), join("plugin", "marketplace"), 288);
await emit(categoryIcon(), join("plugin", "category-icon"), 28);

for (const entry of ACTIONS) {
	await emit(listIcon(entry.glyph), join("actions", entry.dir, "icon"), 20);

	for (const state of entry.states) {
		await emit(keyTile({ glyph: state.glyph, title: state.title, tone: state.tone }), join("actions", entry.dir, state.name), 72);
	}
}

await writeFile(join(out, ".gitattributes"), "*.png binary\n", "utf8");
console.log(`icons written to ${out}`);
