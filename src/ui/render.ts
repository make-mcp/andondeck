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

/** What Clawd is doing with arms, legs and eyes. */
export type Pose =
	/** Arms out, standing still. */
	| "stand"
	/** Mid-stride. */
	| "walk"
	/** Right hand up: a hello, or "hold on". */
	| "wave"
	/** Both hands up. */
	| "cheer"
	/** Arms hanging, eyes half shut. */
	| "droop"
	/** Eyes closed, a "z" above. */
	| "sleep";

/** Pose and colour for each session state. */
const MOOD_LOOK: Record<Mood, { pose: Pose; body: string; z?: boolean }> = {
	working: { pose: "walk", body: CLAWD },
	waiting: { pose: "wave", body: CLAWD },
	idle: { pose: "sleep", body: CLAWD },
	error: { pose: "stand", body: "#D1483F" },
	// Eyes shut, but no "z": switched off, not resting.
	offline: { pose: "sleep", body: "#5E5852", z: false },
};

type Cells = { rows: string[]; extra: [number, number, number, number][]; eyes: "open" | "closed" | "half" };

/**
 * Lays out the 17 × 10 cells of one pose.
 * @param pose The pose.
 * @param step Which foot is forward, for a walk.
 */
function cells(pose: Pose, step: boolean): Cells {
	// Arms gone from the sides; poses that move them draw them back as extras.
	const armless = "..CCCCCCCCCCCCC..";
	const rightOnly = "CCCCCCCCCCCCCCC..";
	const rows = [...CLAWD_BODY];
	const extra: Cells["extra"] = [];

	switch (pose) {
		case "wave":
			rows[4] = rows[5] = rightOnly;
			extra.push([15, 3, 2, 2], [16, 0, 1, 3]);
			break;
		case "cheer":
			rows[4] = rows[5] = armless;
			extra.push([0, 3, 2, 2], [0, 0, 1, 3], [15, 3, 2, 2], [16, 0, 1, 3]);
			break;
		case "droop":
			rows[4] = rows[5] = armless;
			extra.push([1, 4, 1, 1], [0, 5, 1, 3], [15, 4, 1, 1], [16, 5, 1, 3]);
			break;
		default:
			break;
	}

	const legs = pose === "walk" ? (step ? CLAWD_LEGS.stepA : CLAWD_LEGS.stepB) : CLAWD_LEGS.still;
	rows.push(legs, legs);

	return { rows, extra, eyes: pose === "sleep" ? "closed" : pose === "droop" ? "half" : "open" };
}

/**
 * Renders a pose as crisp cells.
 * @param look Pose, body colour, eye colour (`null` cuts the eyes out), and
 *   whether a sleeping pose gets its "z".
 * @param x0 Left edge.
 * @param y0 Top edge.
 * @param cell Size of one cell.
 * @param step Which foot is forward, for a walk.
 */
function drawPose(look: { pose: Pose; body: string; eye: string | null; z?: boolean }, x0: number, y0: number, cell: number, step: boolean): string {
	const { rows, extra, eyes } = cells(look.pose, step);
	const rects: string[] = [];
	const add = (x: number, y: number, w: number, h: number, fill: string) =>
		rects.push(`<rect x="${(x0 + x * cell).toFixed(2)}" y="${(y0 + y * cell).toFixed(2)}" width="${(w * cell + 0.05).toFixed(2)}" height="${(h * cell + 0.05).toFixed(2)}" fill="${fill}"/>`);

	rows.forEach((row, y) => {
		[...row].forEach((ch, x) => {
			if (ch === "C") {
				add(x, y, 1, 1, look.body);
				return;
			}
			if (ch !== "E") {
				return;
			}

			// Eyes are two cells tall. Closed, they shrink to a line on the lower
			// cell; half shut, only the lower cell stays dark.
			const lower = y === 3;
			if (eyes === "open" || (eyes === "half" && lower)) {
				if (look.eye) {
					add(x, y, 1, 1, look.eye);
				}
				return;
			}

			// Without an eye colour, a closed eye is just the gap of its lower cell.
			if (!look.eye && eyes === "closed" && lower) {
				return;
			}
			add(x, y, 1, 1, look.body);
			if (look.eye && eyes === "closed" && lower) {
				rects.push(`<rect x="${(x0 + (x - 0.3) * cell).toFixed(2)}" y="${(y0 + (y + 0.35) * cell).toFixed(2)}" width="${(cell * 1.6).toFixed(2)}" height="${(cell * 0.45).toFixed(2)}" fill="${look.eye}"/>`);
			}
		});
	});

	for (const [x, y, w, h] of extra) {
		add(x, y, w, h, look.body);
	}

	if (look.pose === "sleep" && look.z !== false) {
		rects.push(`<text x="${(x0 + 17.5 * cell).toFixed(2)}" y="${(y0 - 0.3 * cell).toFixed(2)}" font-family="${FONT}" font-size="${(cell * 3).toFixed(1)}" font-weight="700" fill="${look.body}" opacity=".8">z</text>`);
	}

	return rects.join("");
}

/**
 * Draws Clawd as the face of a session key.
 * @param mood Session state, which picks pose and colour.
 * @param phase 0–1 animation position.
 * @param cx Horizontal centre.
 * @param top Top edge.
 * @param cell Size of one pixel cell.
 * @returns SVG markup.
 */
export function clawd(mood: Mood, phase: number, cx: number, top: number, cell: number): string {
	const look = MOOD_LOOK[mood];
	const walking = look.pose === "walk";
	const step = Math.floor(phase * 4) % 2 === 0;
	// A one-cell bob while working; perfectly still otherwise.
	const y0 = top + (walking && step ? -cell * 0.5 : 0);
	const x0 = cx - (17 * cell) / 2;

	return `<g shape-rendering="crispEdges">${drawPose({ ...look, eye: "#14110F" }, x0, y0, cell, step)}</g>`;
}

/** How strongly the background Clawd shows through. */
const GHOST_OPACITY = 0.13;

/**
 * Clawd as a watermark behind a key's words.
 *
 * Big, still and faint: it gives a key character without competing with what
 * the key says. One flat colour with the eyes cut out, so it reads as a shape
 * rather than as a second thing to look at.
 * @param pose The pose.
 * @param color Colour of the shape.
 * @returns SVG markup.
 */
export function ghost(pose: Pose, color: string): string {
	const cell = 2.9;
	const x0 = 36 - (17 * cell) / 2;
	// Standing on the bottom border, so the raised arms and the head clear
	// most headlines and the pose still reads.
	const y0 = 69 - 10 * cell;
	// No "z" here: at this size it would poke out of the key.
	const shapes = drawPose({ pose, body: color, eye: null, z: false }, x0, y0, cell, true);
	return `<g shape-rendering="crispEdges" opacity="${GHOST_OPACITY}">${shapes}</g>`;
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
	/** Draws a small chart under the headline, in place of the caption. */
	chart?: ChartData;
	/**
	 * Faint Clawd behind the words. Defaults to the family's pose; `false`
	 * leaves the key plain.
	 */
	ghost?: Pose | false;
};

/**
 * The background pose each family of keys gets unless it asks for another.
 * Meters have none: their numbers and charts need the whole key.
 */
const FAMILY_POSE: Partial<Record<TileFamily, Pose>> = {
	allow: "cheer",
	always: "cheer",
	deny: "droop",
	control: "wave",
	queue: "walk",
	launch: "walk",
	session: "wave",
};

let ghostsEnabled = true;

/** Turns the background Clawd on or off on every key. */
export function setGhosts(enabled: boolean): void {
	ghostsEnabled = enabled;
}

/** A series small enough for a key: a week of days, half a day of hours. */
export type ChartData = {
	/** Values, oldest first. The last one is "now" and is drawn brightest. */
	series: number[];
	/** Bars for counts per period, a line for a level that moves. */
	kind: "bars" | "line";
	/** Top of the scale; defaults to the largest value. */
	max?: number;
};

/**
 * Plots a series into a box.
 * @param chart What to plot.
 * @param box Left, top, width, height.
 * @param color Colour of the current value.
 * @param rail Colour of the baseline and of past values.
 * @returns SVG markup.
 */
export function plot(chart: ChartData, box: [number, number, number, number], color: string, rail: string): string {
	const [x, y, w, h] = box;
	const values = chart.series.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
	const max = Math.max(chart.max ?? 0, ...values, 1e-9);
	const floor = y + h;
	const base = `<rect x="${x}" y="${(floor - 0.6).toFixed(2)}" width="${w}" height="0.6" fill="${rail}" opacity=".6"/>`;

	if (values.length === 0) {
		return base;
	}

	if (chart.kind === "bars") {
		const slot = w / values.length;
		const gap = Math.min(slot * 0.25, 2);
		return (
			base +
			values
				.map((value, index) => {
					// A sliver for an empty period still says "nothing happened".
					const height = value > 0 ? Math.max(1.2, (value / max) * (h - 1)) : 0.6;
					const current = index === values.length - 1;
					return `<rect x="${(x + index * slot + gap / 2).toFixed(2)}" y="${(floor - height).toFixed(2)}" width="${(slot - gap).toFixed(2)}" height="${height.toFixed(2)}" rx="${Math.min(1, (slot - gap) / 4).toFixed(2)}" fill="${current ? color : rail}"${current ? "" : ' opacity=".75"'}/>`;
				})
				.join("")
		);
	}

	const step = values.length > 1 ? w / (values.length - 1) : 0;
	const points = values.map((value, index) => [x + index * step, floor - (value / max) * (h - 1.5)] as const);
	const line = points.map(([px, py]) => `${px.toFixed(2)},${py.toFixed(2)}`).join(" ");
	const [lastX, lastY] = points[points.length - 1];
	const area = `${x},${floor} ${line} ${lastX.toFixed(2)},${floor}`;
	// A full-scale guide makes a percentage chart read as "how close to the top".
	const guide =
		chart.max !== undefined
			? `<rect x="${x}" y="${y}" width="${w}" height="0.5" fill="${rail}" opacity=".45"/>`
			: "";

	return (
		base +
		guide +
		`<polygon points="${area}" fill="${color}" opacity=".18"/>` +
		`<polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>` +
		`<circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="1.9" fill="${color}"/>`
	);
}

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
	const chart = options.chart;
	const hasBottom = Boolean(options.subtitle) && !mascot && !chart;

	// A flooded key is interrupting; a watermark would only muddy it.
	const pose =
		!ghostsEnabled || solid || mascot || chart || options.ghost === false
			? undefined
			: (options.ghost ?? (options.family ? FAMILY_POSE[options.family] : undefined));

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
	const bandBottom = mascot ? 44 : chart ? 40 : hasBottom ? bottomY - 13 : options.progress === undefined ? 66 : 58;

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
		${pose ? ghost(pose, hue ?? PALETTE.ink) : ""}
		${solid ? "" : edge(options.edge ?? "quiet", hue && (options.edge ?? "quiet") === "quiet" ? hue : tone, phase)}
		${top}
		${mascot ? clawd(mascot, phase, 36, 46, 2.2) : ""}
		${chart ? plot(chart, [11, 43, 50, 20], options.tone === "accent" && hue && !solid ? hue : tone, solid ? "rgba(26,21,18,.4)" : "rgba(255,255,255,.22)") : ""}
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

/** Formats a token count compactly: `940`, `12.4k`, `1.2M`, `115M`, `1.4B`. */
export function compactNumber(value: number): string {
	if (value < 1000) {
		return String(Math.round(value));
	}
	if (value < 1_000_000) {
		return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	}
	if (value < 1_000_000_000) {
		return `${(value / 1_000_000).toFixed(value < 100_000_000 ? 1 : 0)}M`;
	}
	return `${(value / 1_000_000_000).toFixed(1)}B`;
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

/**
 * A dial's segment of the touch strip, drawn whole: label, reading and chart.
 *
 * Stream Deck's stock layouts have no chart, so the segment is one picture
 * placed in a single full-size pixmap (see `layouts/chart.json`).
 * @returns A data URI for a 200 × 100 image.
 */
export function strip(options: { title: string; value: string; subtitle?: string; tone: TileTone; chart: ChartData }): string {
	const tone = options.tone === "accent" ? FAMILY.meter : PALETTE[options.tone];
	const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

	return toDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
		<rect width="200" height="100" fill="#000"/>
		<text x="12" y="20" font-family="${FONT}" font-size="14" font-weight="600" fill="${PALETTE.inkDim}">${escapeXml(clip(options.title, 14))}</text>
		<text x="188" y="20" font-family="${FONT}" font-size="20" font-weight="700" fill="${PALETTE.ink}" text-anchor="end">${escapeXml(clip(options.value, 8))}</text>
		${plot(options.chart, [12, 32, 176, options.subtitle ? 44 : 58], tone, "rgba(255,255,255,.25)")}
		${options.subtitle ? `<text x="12" y="94" font-family="${FONT}" font-size="12" font-weight="500" fill="${PALETTE.inkDim}">${escapeXml(clip(options.subtitle, 28))}</text>` : ""}
	</svg>`);
}
