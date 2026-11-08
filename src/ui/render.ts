/**
 * Key artwork, drawn as SVG data URIs.
 *
 * Stream Deck renders a key at 144x144 but authors at 72x72, so everything here
 * works on a 72-unit grid and stays vector so it survives the upscale.
 */

export const PALETTE = {
	/** Claude's terracotta, used as the plugin's accent throughout. */
	accent: "#d97757",
	idle: "#5a9e78",
	working: "#d9a157",
	waiting: "#7f8ff0",
	compacting: "#9b7fd0",
	error: "#d4604f",
	offline: "#4a4a4d",
	ink: "#f5f3ef",
	inkDim: "#9d9a94",
	backdrop: "#17171a",
} as const;

export type TileTone = keyof typeof PALETTE;

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
 * as `%23`, which not every consumer decodes before handing the markup to an
 * SVG parser.
 */
export function toDataUri(svg: string): string {
	const compact = svg.replace(/\s{2,}/g, " ").trim();
	return `data:image/svg+xml;base64,${Buffer.from(compact, "utf8").toString("base64")}`;
}

const FONT = "'Segoe UI','SF Pro Text',system-ui,-apple-system,sans-serif";

type TextLine = {
	text: string;
	size: number;
	color: string;
	weight?: number;
	/** Baseline position on the 72-unit grid. */
	y: number;
};

function lines(entries: TextLine[]): string {
	return entries
		.filter((line) => line.text)
		.map(
			(line) =>
				`<text x="36" y="${line.y}" font-family="${FONT}" font-size="${line.size}" font-weight="${line.weight ?? 600}" fill="${line.color}" text-anchor="middle">${escapeXml(line.text)}</text>`,
		)
		.join("");
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

export type TileOptions = {
	tone: TileTone;
	/** Glyph or short string shown large in the middle. */
	glyph?: string;
	/** Headline under the glyph. */
	title?: string;
	/** Dim second line. */
	subtitle?: string;
	/** Small label across the top. */
	eyebrow?: string;
	/** 0–1; draws a progress rail along the bottom edge. */
	progress?: number;
	/** Count badge in the top-right corner. */
	badge?: number | string;
	/** Fills the whole key with the tone instead of just accenting it. */
	solid?: boolean;
};

/**
 * Builds a key image.
 * @param options What to draw.
 * @returns An SVG data URI ready for `setImage`.
 */
export function tile(options: TileOptions): string {
	const tone = PALETTE[options.tone];
	const background = options.solid ? tone : PALETTE.backdrop;
	const ink = options.solid ? "#1b1210" : PALETTE.ink;
	const dim = options.solid ? "rgba(27,18,16,.72)" : PALETTE.inkDim;

	const body: TextLine[] = [];
	let y = options.eyebrow ? 20 : 16;

	if (options.eyebrow) {
		body.push({ text: options.eyebrow.toUpperCase(), size: 8, color: dim, weight: 700, y: 13 });
	}

	if (options.glyph) {
		const size = options.glyph.length > 3 ? 20 : options.glyph.length > 1 ? 26 : 30;
		y += size * 0.82;
		body.push({ text: options.glyph, size, color: options.solid ? ink : tone, weight: 700, y });
		y += 6;
	}

	if (options.title) {
		for (const line of fit(options.title, 13)) {
			y += 12;
			body.push({ text: line, size: 11, color: ink, weight: 600, y });
		}
	}

	if (options.subtitle) {
		for (const line of fit(options.subtitle, 16)) {
			y += 10;
			body.push({ text: line, size: 9, color: dim, weight: 500, y });
		}
	}

	const rail =
		options.progress === undefined
			? ""
			: `<rect x="6" y="64" width="60" height="3" rx="1.5" fill="rgba(255,255,255,.14)"/>` +
				`<rect x="6" y="64" width="${Math.max(1.5, Math.min(1, Math.max(0, options.progress)) * 60)}" height="3" rx="1.5" fill="${tone}"/>`;

	const badge =
		options.badge === undefined || options.badge === 0 || options.badge === ""
			? ""
			: `<circle cx="60" cy="12" r="10" fill="${tone}"/>` +
				`<text x="60" y="16" font-family="${FONT}" font-size="11" font-weight="700" fill="#1b1210" text-anchor="middle">${escapeXml(String(options.badge))}</text>`;

	const edge = options.solid ? "" : `<rect x="0" y="0" width="72" height="3" fill="${tone}"/>`;

	return toDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
		<rect width="72" height="72" rx="9" fill="${background}"/>
		${edge}
		${lines(body)}
		${rail}
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
