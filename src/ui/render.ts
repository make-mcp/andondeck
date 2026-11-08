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
	/** Primary line, set larger than {@link TileOptions.title}. Use one or the other. */
	headline?: string;
	/** Primary caption, sentence case. */
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
};

type TextLine = { text: string; size: number; color: string; weight: number; y?: number };

/** Usable width inside the key, leaving room for the border. */
const CONTENT_WIDTH = 58;

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
	// Sized for the widest plausible host font rather than the intended one.
	// `textLength` is not honoured by every SVG renderer, so the estimate has to
	// hold on its own; text a little small beats a project name running off the
	// edge of the key.
	return value.length * size * (weight >= 600 ? 0.68 : 0.60);
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
function text(line: Required<TextLine>): string {
	const width = Math.min(CONTENT_WIDTH, measure(line.text, line.size, line.weight));

	return `<text x="36" y="${line.y.toFixed(1)}" font-family="${FONT}" font-size="${line.size}" font-weight="${line.weight}" fill="${line.color}" text-anchor="middle" textLength="${width.toFixed(1)}" lengthAdjust="spacingAndGlyphs">${escapeXml(line.text)}</text>`;
}

/**
 * Stacks the body lines in the space left between the eyebrow and the footer.
 *
 * Centring the block rather than accumulating from the top keeps a one-line key
 * and a three-line key looking like members of the same set.
 * @param entries Lines to place.
 * @param top First usable baseline area.
 * @param bottom Last usable position.
 * @returns SVG markup.
 */
function stack(entries: TextLine[], top: number, bottom: number): string {
	const visible = entries.filter((line) => line.text);
	if (visible.length === 0) {
		return "";
	}

	// Line height, not font size: ascenders and descenders need the difference,
	// otherwise the last line sits on the bottom edge of the key.
	const gaps = (visible.length - 1) * 1.5;
	const natural = visible.reduce((sum, line) => sum + line.size * 1.14, 0) + gaps;

	// A key with an eyebrow, a mark, a title and a caption can ask for more room
	// than it has. Scale the whole block rather than letting the last line fall
	// off the bottom edge.
	const scale = Math.min(1, (bottom - top - gaps) / Math.max(1, natural - gaps));
	const scaled = visible.map((line) => ({ ...line, size: Math.round(line.size * scale * 2) / 2 }));
	const heights = scaled.map((line) => line.size * 1.14);
	const height = heights.reduce((sum, value) => sum + value, 0) + gaps;

	let cursor = top + Math.max(0, (bottom - top - height) / 2);

	return scaled
		.map((line, index) => {
			// Place the baseline, leaving room below it for descenders.
			cursor += heights[index] * 0.82;
			const markup = text({ ...line, y: cursor });
			cursor += heights[index] * 0.18 + 1.5;
			return markup;
		})
		.join("");
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

	const body: TextLine[] = [];

	if (options.glyph) {
		const size = options.glyph.length > 3 ? 19 : options.glyph.length > 1 ? 24 : 29;
		body.push({ text: options.glyph, size, color: solid ? ink : tone, weight: 700 });
	}

	if (options.headline) {
		const { size, rows } = autoFit(options.headline, 15, 10, 650);
		for (const row of rows) {
			body.push({ text: row, size, color: ink, weight: 650 });
		}
	}

	if (options.title) {
		const { size, rows } = autoFit(options.title, 12, 8.5, 600);
		for (const row of rows) {
			body.push({ text: row, size, color: ink, weight: 600 });
		}
	}

	if (options.subtitle) {
		const { size, rows } = autoFit(options.subtitle, 9.5, 7.5, 500);
		for (const row of rows) {
			body.push({ text: row, size, color: dim, weight: 500 });
		}
	}

	// The footer is reserved when a bar is drawn, so the two never collide.
	const top = options.eyebrow ? 17 : 9;
	const bottom = options.progress === undefined ? 66 : 58;

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
		${solid ? "" : edge(options.edge ?? "quiet", tone, phase)}
		${options.eyebrow ? text({ text: options.eyebrow, size: 8, color: dim, weight: 600, y: 14 }) : ""}
		${stack(body, top, bottom)}
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
