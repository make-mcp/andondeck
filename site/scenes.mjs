/**
 * Deck scenes shared by the website and the Marketplace images: the XL layout
 * the profiles ship, drawn by the plugin's own renderer in a given state.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const R = await import(join(root, ".test-build/ui/render.js"));
export const { tile, alertScene, alertKey, strip } = R;

/** Raw SVG markup of a data URI the renderer produced. */
export const svgOf = (uri) => Buffer.from(uri.split(",")[1], "base64").toString("utf8");

// ---------------------------------------------------------------------------
// Keys, configured the way the plugin's actions draw them.
// ---------------------------------------------------------------------------

export const PHASES = 8;

/** A native Text key, drawn like the artwork the profiles ship. */
export function typed(command, label) {
	const font = "'Segoe UI','DejaVu Sans',sans-serif";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><rect width="72" height="72" rx="9" fill="#201E1C"/><rect x="1" y="1" width="70" height="70" rx="8" fill="none" stroke="#B9B2A8" stroke-opacity=".55" stroke-width="2"/><text x="36" y="21" font-family="${font}" font-size="9" font-weight="600" fill="#948E86" text-anchor="middle">TYPES</text><text x="36" y="42" font-family="${font}" font-size="${Math.min(14, 58 / (0.72 * command.length)).toFixed(1)}" font-weight="700" fill="#F2EFEA" text-anchor="middle">${command}</text><text x="36" y="58" font-family="${font}" font-size="9" fill="#948E86" text-anchor="middle">${label}</text></svg>`;
}

const MOOD = { idle: "idle", working: "working", waiting: "waiting", error: "error", offline: "offline" };

export function slot(index, session, phase) {
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

export function approve(verdict, pending, phase) {
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

export const queue = (label, queued, project = "shop") =>
	svgOf(tile({ family: "queue", tone: "accent", eyebrow: "Queue", headline: label, subtitle: project, badge: queued || undefined }));

export const meter = (eyebrow, headline, subtitle, tone, progress, chart) =>
	svgOf(tile({ family: "meter", tone, eyebrow, headline, subtitle, progress, chart }));

export const WEEK = [38e6, 61e6, 12e6, 0, 74e6, 55e6, 41e6];

/**
 * The XL layout the profiles ship, in one state.
 * @param s Scene state.
 * @param phase 0–1 animation position.
 * @returns 32 SVG strings, row by row.
 */
export function xl(s, phase) {
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
export function xlAlert(frame) {
	const scene = alertScene(8, 4, frame, "shop");
	return Array.from({ length: 32 }, (_, i) => svgOf(alertKey(scene, i % 8, Math.floor(i / 8))));
}

