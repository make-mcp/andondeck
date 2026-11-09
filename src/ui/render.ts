/**
 * Key artwork.
 *
 * A Stream Deck key is a 19mm square read from across a desk, usually out of
 * the corner of an eye, in a row of others. That rules the design: the state
 * has to carry at a distance, and the text is for when you actually look.
 *
 * So state lives on the edge and information lives in the middle. The key's own
 * border is the indicator — a light that travels it while Claude works, a pulse
 * when Claude needs you, a broken ring when it failed. The borrowed idea is the
 * andon lamp on a factory floor, which solved "read machine state from ten
 * metres" long before screens did.
 *
 * Colour is reserved for machine state. Keys you press are graphite, so a lit
 * key in a row always means Claude is telling you something.
 *
 * Authored at 72 units; Stream Deck renders it at 144.
 */

export const PALETTE = {
	/** Warm graphite, to sit beside Stream Deck's own chrome without going blue. */
	backdrop: "#201E1C",
	ink: "#F2EFEA",
	inkDim: "#948E86",

	/** Machine states, following andon convention. */
	idle: "#9AA09C",
	working: "#4C9A6A",
	waiting: "#E8A33D",
	compacting: "#5B86C4",
	error: "#D1483F",
	offline: "#46423E",

	/** Interactive keys. Deliberately achromatic so state keys own the colour. */
	accent: "#B9B2A8",
} as const;

export type TileTone = keyof typeof PALETTE;

/**
 * One colour per family of keys, so a full XL reads as groups at a glance
 * instead of thirty grey squares. Families tint the key; the andon state
 * colours above still own the status words and moving borders.
 */
export const FAMILY = {
	/** Answering Claude: positive. */
	allow: "#3FB37A",
	/** Answering Claude: positive, and permanent. */
	always: "#2BB3B1",
	/** Answering Claude: negative. */
	deny: "#E5534B",
	/** Stopping or steering Claude. */
	control: "#F08A3C",
	/** Prompts lined up for later. */
	queue: "#4F8FE8",
	/** Starting something new. */
	launch: "#A06CE4",
	/** Numbers to watch. */
	meter: "#E2B93B",
	/** Sessions and connection. */
	session: "#D97757",
} as const;

export type TileFamily = keyof typeof FAMILY;

/** How the mascot carries itself, mirroring the session state. */
export type Mood = "working" | "waiting" | "idle" | "error" | "offline";

/** Clawd's body colour, as Claude Code itself draws it. */
const CLAWD = "#D77757";

/**
 * Clawd, Claude Code's mascot, in its neutral pose.
 *
 * Taken from the pixel map Claude Code ships (`C` body, `E` eye), squared up
 * so both arms rest at the sides. Every band in that map is two cells tall —
 * eyes, arms, lower body and legs alike; halving any of them squashes Clawd
 * into a flat bar. 17 × 10 cells.
 */
const CLAWD_BODY = [
	"..CCCCCCCCCCCCC..",
	"..CCCCCCCCCCCCC..",
	"..CCCECCCCCECCC..",
	"..CCCECCCCCECCC..",
	"CCCCCCCCCCCCCCCCC",
	"CCCCCCCCCCCCCCCCC",
	"..CCCCCCCCCCCCC..",
	"..CCCCCCCCCCCCC..",
];

/** Leg row, drawn twice: still, and the two steps of a walk. */
const CLAWD_LEGS = {
	still: "..C.C.......C.C..",
	stepA: "..C..C.....C..C..",
	stepB: ".C..C.......C..C.",
};

/**
 * Draws Clawd.
 * @param mood Pose and colour.
 * @param phase 0–1 animation position.
 * @param cx Horizontal centre.
 * @param top Top edge.
 * @param cell Size of one pixel cell.
 * @returns SVG markup.
 */
export function clawd(mood: Mood, phase: number, cx: number, top: number, cell: number): string {
	const body = mood === "offline" ? "#5E5852" : mood === "error" ? "#D1483F" : CLAWD;
	const eye = "#14110F";
	const walking = mood === "working";
	const step = Math.floor(phase * 4) % 2 === 0;
	// A one-cell bob while working; perfectly still otherwise.
	const y0 = top + (walking && step ? -cell * 0.5 : 0);
	const x0 = cx - (17 * cell) / 2;

	const rows = CLAWD_BODY.map((row, index) => {
		// Waiting: the right arm goes up, like a hand raised for attention.
		if (mood === "waiting" && (index === 4 || index === 5)) {
			return "CCCCCCCCCCCCCCC..";
		}
		return row;
	});
	const legs = walking ? (step ? CLAWD_LEGS.stepA : CLAWD_LEGS.stepB) : CLAWD_LEGS.still;
	rows.push(legs, legs);

	const rects: string[] = [];
	const add = (x: number, y: number, w: number, h: number, fill: string) =>
		rects.push(`<rect x="${(x0 + x * cell).toFixed(2)}" y="${(y0 + y * cell).toFixed(2)}" width="${(w * cell + 0.05).toFixed(2)}" height="${(h * cell + 0.05).toFixed(2)}" fill="${fill}"/>`);

	rows.forEach((row, y) => {
		[...row].forEach((ch, x) => {
			if (ch === "C") {
				add(x, y, 1, 1, body);
			} else if (ch === "E") {
				add(x, y, 1, 1, body);
				// Asleep or offline: the eyes close to a thin line.
				const closed = mood === "idle" || mood === "offline";
				if (!closed) {
					add(x, y, 1, 1, eye);
				} else if (y === 3) {
					rects.push(`<rect x="${(x0 + (x - 0.3) * cell).toFixed(2)}" y="${(y0 + (y + 0.35) * cell).toFixed(2)}" width="${(cell * 1.6).toFixed(2)}" height="${(cell * 0.45).toFixed(2)}" fill="${eye}"/>`);
				}
			}
		});
	});

	if (mood === "waiting") {
		// The raised arm, straight up from the shoulder.
		add(15, 3, 2, 2, body);
		add(16, 0, 1, 3, body);
	}

	if (mood === "idle") {
		// Resting: a small "z" drifting above.
		rects.push(`<text x="${(x0 + 17.5 * cell).toFixed(2)}" y="${(y0 - 0.3 * cell).toFixed(2)}" font-family="${FONT}" font-size="${(cell * 3).toFixed(1)}" font-weight="700" fill="${body}" opacity=".8">z</text>`);
	}

	return `<g shape-rendering="crispEdges">${rects.join("")}</g>`;
}

/** Perimeter of the 72-unit rounded square the border traces. */
const PERIMETER = 2 * (72 - 2 * 9) + 2 * Math.PI * 9;

const FONT = "'Segoe UI','SF Pro Text',system-ui,-apple-system,sans-serif";

function escapeXml(value: string): string {
	return value.replace(/[<>&'"]/g, (char) => {
		switch (char) {
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case "&":
				return "&amp;";
			case "'":
				return "&apos;";
			default:
				return "&quot;";
		}
	});
}

/**
 * Wraps a finished SVG document into the data URI Stream Deck expects.
 *
 * Base64 rather than percent-encoding: the latter leaves `#` in colour values
 * as `%23`, which is not reliably decoded before the markup reaches a parser.
 */
export function toDataUri(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg.replace(/\s{2,}/g, " ").trim(), "utf8").toString("base64")}`;
}

/**
 * Breaks a label into at most two lines that fit the key width.
 * @param text Text to fit.
 * @param perLine Characters that fit on one line at the chosen size.
 * @returns One or two lines.
 */
export function fit(text: string, perLine: number): string[] {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= perLine) {
		return [flat];
	}

	const words = flat.split(" ");
	let first = "";
	while (words.length > 0 && `${first} ${words[0]}`.trim().length <= perLine) {
		first = `${first} ${words.shift()}`.trim();
	}

	if (!first) {
		return [flat.slice(0, perLine), `${flat.slice(perLine, perLine * 2 - 1)}…`];
	}

	const rest = words.join(" ");
	return [first, rest.length > perLine ? `${rest.slice(0, perLine - 1)}…` : rest];
}

/** How the border behaves, which is what the key says from a distance. */
export type EdgeMotion =
	/** Thin and still: nothing is happening. */
	| "quiet"
	/** A light travels the border: Claude is working. */
	| "travel"
	/** The whole edge breathes: Claude is waiting on you. */
	| "pulse"
	/** A ring with a gap, held still: it stopped. */
	| "broken"
	/** Dashes drifting: a long operation with no progress to report. */
	| "drift";

export type TileOptions = {
	tone: TileTone;
	/** Large mark in the upper half; omit for text-only keys. */
	glyph?: string;
	/** The line you read at a glance. Give it one or two words. */
	headline?: string;
	/** Draws the headline in the state colour, the way a status word should read. */
	headlineTone?: "ink" | "state";
	/** Deprecated alias for {@link TileOptions.headline}. */
	title?: string;
	/** Secondary caption, quieter. */
	subtitle?: string;
	/** Small label along the top, sentence case. */
	eyebrow?: string;
	/** 0–1; draws a determinate bar along the bottom instead of a caption. */
	progress?: number;
	/** Count in the top-right corner. */
	badge?: number | string;
	/** Floods the key with the tone. Reserve it for states that must interrupt. */
	solid?: boolean;
	/** Border behaviour; defaults to `quiet`. */
	edge?: EdgeMotion;
	/** 0–1 animation position, advanced by the caller each frame. */
	phase?: number;
	/** Tints the key with its family colour; see {@link FAMILY}. */
	family?: TileFamily;
	/** Puts Clawd under the headline, in place of the caption. */
	mascot?: Mood;
};

type TextLine = { text: string; size: number; color: string; weight: number; y: number };

/** Usable width inside the key, leaving room for the border. */
const CONTENT_WIDTH = 62;

/**
 * Approximate rendered width of a string.
 *
 * Close enough to keep text inside a 72-unit key, which is all that matters
 * here; the alternative is measuring glyphs the renderer has not loaded yet.
 * @param text The text.
 * @param size Font size in units.
 * @param weight Font weight.
 * @returns Width in units.
 */
function measure(value: string, size: number, weight: number): number {
	// Segoe UI on Windows, SF Pro on macOS — the deck reports which it uses.
	// `textLength` keeps a wider fallback font in line, so these can be honest
	// rather than defensive; being defensive here is what made the text small.
	return value.length * size * (weight >= 600 ? 0.58 : 0.53);
}

/**
 * Fits text to the key by shrinking it, then wrapping it.
 *
 * Shrinking first keeps a project name on one line, which is what makes two
 * keys tellable apart at a glance.
 * @param text The text.
 * @param max Largest acceptable size.
 * @param min Smallest acceptable size.
 * @param weight Font weight, which affects width.
 * @returns The chosen size and the lines to draw.
 */
function autoFit(value: string, max: number, min: number, weight: number): { size: number; rows: string[] } {
	const flat = value.replace(/\s+/g, " ").trim();

	for (let size = max; size >= min; size -= 0.5) {
		if (measure(flat, size, weight) <= CONTENT_WIDTH) {
			return { size, rows: [flat] };
		}
	}

	// A single long token wraps badly. Trim it instead, which keeps the start of
	// a project name — the part that tells two keys apart.
	if (!flat.includes(" ")) {
		const fits = Math.floor(CONTENT_WIDTH / (min * (weight >= 600 ? 0.68 : 0.6)));
		return { size: min, rows: [flat.length > fits ? `${flat.slice(0, fits - 1)}…` : flat] };
	}

	const perLine = Math.floor(CONTENT_WIDTH / (min * (weight >= 600 ? 0.58 : 0.53)));
	return { size: min, rows: fit(flat, perLine) };
}

/**
 * Draws one line at a width this code decides, not one the font decides.
 *
 * The artwork is authored against Segoe UI but rendered by whatever the host
 * has; a width derived from character counts is therefore a guess, and a wrong
 * guess clips the text off the key. Always setting `textLength` turns the
 * estimate into a specification: every font lands on the same width, so a
 * project name never runs off the edge.
 * @param line The line, with its baseline resolved.
 * @returns SVG markup.
 */
function text(line: TextLine): string {
	// Last guard: trim anything still too long, so a caption cannot run off the
	// key even on a renderer that ignores textLength.
	const perChar = line.size * (line.weight >= 600 ? 0.58 : 0.53);
	const fits = Math.max(1, Math.floor(CONTENT_WIDTH / perChar));
	const value = line.text.length > fits ? `${line.text.slice(0, fits - 1)}…` : line.text;
	const width = Math.min(CONTENT_WIDTH, measure(value, line.size, line.weight));

	return `<text x="36" y="${line.y.toFixed(1)}" font-family="${FONT}" font-size="${line.size}" font-weight="${line.weight}" fill="${line.color}" text-anchor="middle" textLength="${width.toFixed(1)}" lengthAdjust="spacingAndGlyphs">${escapeXml(value)}</text>`;
}

/**
 * Draws the border, which is where the state lives.
 * @param motion How it should behave.
 * @param tone Resolved state colour.
 * @param phase 0–1 animation position.
 * @returns SVG markup.
 */
function edge(motion: EdgeMotion, tone: string, phase: number): string {
	const box = (width: number, color: string, extra = "") =>
		`<rect x="${width / 2}" y="${width / 2}" width="${72 - width}" height="${72 - width}" rx="${9 - width / 4}" fill="none" stroke="${color}" stroke-width="${width}" ${extra}/>`;

	switch (motion) {
		case "travel": {
			// A short arc of light running the perimeter, with a dim rail behind it.
			const run = PERIMETER * 0.28;
			return (
				box(2, tone, 'opacity=".22"') +
				box(
					3,
					tone,
					`stroke-linecap="round" stroke-dasharray="${run} ${PERIMETER - run}" stroke-dashoffset="${-phase * PERIMETER}"`,
				)
			);
		}

		case "pulse": {
			// Breathing, not blinking: it should pull the eye without nagging.
			const breath = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(phase * Math.PI * 2));
			return box(2, tone, 'opacity=".3"') + box(4, tone, `opacity="${breath.toFixed(3)}"`);
		}

		case "broken": {
			// A ring with a piece missing reads as "stopped", even unlit.
			const gap = PERIMETER * 0.12;
			return box(3, tone, `stroke-dasharray="${PERIMETER - gap} ${gap}" stroke-dashoffset="${-PERIMETER * 0.06}"`);
		}

		case "drift": {
			const dash = PERIMETER / 16;
			return box(2, tone, `opacity=".8" stroke-dasharray="${dash} ${dash}" stroke-dashoffset="${-phase * dash * 2}"`);
		}

		default:
			// Present, not loud: a resting key should still look deliberate.
			return box(2, tone, 'opacity=".55"');
	}
}

/**
 * Builds a key image.
 * @param options What to draw.
 * @returns An SVG data URI ready for `setImage`.
 */
export function tile(options: TileOptions): string {
	const tone = PALETTE[options.tone];
	const solid = options.solid === true;
	const field = solid ? tone : PALETTE.backdrop;
	const ink = solid ? "#1A1512" : PALETTE.ink;
	const dim = solid ? "rgba(26,21,18,.68)" : PALETTE.inkDim;
	const phase = options.phase ?? 0;

	// Three slots, never more. A key crammed with four elements has to shrink
	// all of them, which is exactly what makes it unreadable at arm's length.
	const headline = options.headline ?? options.title;
	const hasTop = Boolean(options.eyebrow);
	const mascot = options.mascot;
	const hasBottom = Boolean(options.subtitle) && !mascot;

	const hue = options.family && !solid ? FAMILY[options.family] : undefined;
	const top = hasTop ? text({ text: options.eyebrow!, size: 9, color: hue ?? dim, weight: 650, y: 14 }) : "";
	const bottomY = options.progress === undefined ? 65 : 59;
	const bottom = hasBottom
		? (() => {
				const { size, rows } = autoFit(options.subtitle!, 9.5, 7.5, 500);
				return rows
					.slice(0, 2)
					.map((row, index) => text({ text: row, size, color: dim, weight: 500, y: bottomY - (rows.length - 1 - index) * (size + 1.5) }))
					.join("");
			})()
		: "";

	// The middle band gets whatever the other two leave, and the headline is
	// sized to fill it rather than to fit around a mark.
	const bandTop = hasTop ? 19 : 8;
	const bandBottom = mascot ? 44 : hasBottom ? bottomY - 13 : options.progress === undefined ? 66 : 58;

	let middle = "";
	if (headline) {
		const { size, rows } = autoFit(headline, Math.min(19, (bandBottom - bandTop) / (headline.includes(" ") ? 2.1 : 1.25)), 9.5, 650);
		const height = rows.length * size * 1.14;
		let y = bandTop + Math.max(0, (bandBottom - bandTop - height) / 2);
		middle = rows
			.map((row) => {
				y += size * 1.14 * 0.82;
				const markup = text({
					text: row,
					size,
					color: options.headlineTone === "state" && !solid ? tone : ink,
					weight: 650,
					y,
				});
				y += size * 1.14 * 0.18;
				return markup;
			})
			.join("");
	} else if (options.glyph) {
		const size = Math.min(30, (bandBottom - bandTop) * 0.9);
		middle = text({
			text: options.glyph,
			size,
			color: solid ? ink : tone,
			weight: 700,
			y: bandTop + (bandBottom - bandTop) / 2 + size * 0.36,
		});
	}

	const bar =
		options.progress === undefined
			? ""
			: `<rect x="14" y="63" width="44" height="2" rx="1" fill="${solid ? "rgba(26,21,18,.25)" : "rgba(255,255,255,.12)"}"/>` +
				`<rect x="14" y="63" width="${Math.max(1, Math.min(1, Math.max(0, options.progress)) * 44).toFixed(1)}" height="2" rx="1" fill="${solid ? ink : tone}"/>`;

	const badge =
		options.badge === undefined || options.badge === 0 || options.badge === ""
			? ""
			: `<circle cx="56" cy="16" r="11" fill="${field}"/>` +
				`<circle cx="56" cy="16" r="8.5" fill="${solid ? ink : tone}"/>` +
				`<text x="56" y="20" font-family="${FONT}" font-size="11" font-weight="700" fill="${solid ? tone : "#1A1512"}" text-anchor="middle">${escapeXml(String(options.badge))}</text>`;

	return toDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
		<rect width="72" height="72" rx="9" fill="${field}"/>
		${
			hue
				? `<defs><linearGradient id="h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hue}" stop-opacity=".42"/><stop offset=".75" stop-color="${hue}" stop-opacity=".1"/></linearGradient></defs><rect width="72" height="72" rx="9" fill="url(#h)"/>`
				: ""
		}
		${solid ? "" : edge(options.edge ?? "quiet", hue && (options.edge ?? "quiet") === "quiet" ? hue : tone, phase)}
		${top}
		${mascot ? clawd(mascot, phase, 36, 46, 2.2) : ""}
		${middle}
		${bottom}
		${bar}
		${badge}
	</svg>`);
}

/** Formats a duration the way a key has room for: `8s`, `4:12`, `1:04:12`. */
export function duration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) {
		return `${total}s`;
	}

	const minutes = Math.floor(total / 60) % 60;
	const seconds = total % 60;
	const hours = Math.floor(total / 3600);

	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
		: `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Formats a token count compactly: `940`, `12.4k`, `1.2M`. */
export function compactNumber(value: number): string {
	if (value < 1000) {
		return String(Math.round(value));
	}
	if (value < 1_000_000) {
		return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	}
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Clawd's pose for each session state. */
export const MOODS: Record<"idle" | "working" | "compacting" | "waiting" | "error" | "ended", Mood> = {
	idle: "idle",
	working: "working",
	compacting: "working",
	waiting: "waiting",
	error: "error",
	ended: "offline",
};
