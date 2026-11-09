import assert from "node:assert/strict";
import { describe, it } from "node:test";

import sharp from "sharp";

import { PALETTE, alertKey, alertScene, compactNumber, duration, fit, setGhosts, tile } from "../.test-build/ui/render.js";

/**
 * Decodes a key image and renders it.
 *
 * A key that silently fails to draw is indistinguishable from a broken plugin,
 * so every tile variant is pushed through a real SVG renderer here rather than
 * only being eyeballed on hardware.
 * @param dataUri The value handed to `setImage`.
 * @returns The rasterised size.
 */
async function render(dataUri) {
	const match = /^data:image\/svg\+xml;base64,(.+)$/.exec(dataUri);
	assert.ok(match, `expected a base64 svg data uri, got: ${dataUri.slice(0, 48)}…`);

	const svg = Buffer.from(match[1], "base64").toString("utf8");
	assert.match(svg, /^<svg[^>]+xmlns=/, "the decoded payload must be an svg document");

	const { info } = await sharp(Buffer.from(svg)).png().toBuffer({ resolveWithObject: true });
	return info;
}

describe("key artwork", () => {
	it("renders every tone", async () => {
		for (const tone of Object.keys(PALETTE)) {
			const info = await render(tile({ tone, glyph: "●", title: "Working", subtitle: "acme-api" }));
			assert.equal(info.width, 72);
			assert.equal(info.height, 72);
		}
	});

	it("puts a faint Clawd behind action keys, and only there", async () => {
		const svg = (options) => Buffer.from(tile(options).split(",")[1], "base64").toString("utf8");
		const hasGhost = (options) => svg(options).includes('opacity="0.13"');

		for (const family of ["allow", "always", "deny", "control", "queue", "launch", "session"]) {
			assert.ok(hasGhost({ family, tone: "accent", headline: "Key" }), family);
			await render(tile({ family, tone: "accent", headline: "Key" }));
		}
		for (const pose of ["stand", "walk", "wave", "cheer", "droop", "sleep"]) {
			assert.ok(hasGhost({ tone: "accent", headline: "Key", ghost: pose }), pose);
		}

		assert.ok(!hasGhost({ family: "meter", tone: "accent", headline: "42%" }), "meters stay plain");
		assert.ok(!hasGhost({ family: "allow", tone: "waiting", headline: "Allow", solid: true }), "flooded keys stay plain");
		assert.ok(!hasGhost({ family: "allow", tone: "accent", headline: "Allow", ghost: false }), "opted out");
		assert.ok(!hasGhost({ family: "session", tone: "idle", headline: "Idle", mascot: "idle" }), "one Clawd per key");

		setGhosts(false);
		try {
			assert.ok(!hasGhost({ family: "allow", tone: "accent", headline: "Allow" }), "switched off");
		} finally {
			setGhosts(true);
		}
	});

	it("spreads one alert picture over every key of a deck", async () => {
		for (const [columns, rows] of [[8, 4], [5, 3], [3, 2], [16, 2], [4, 2]]) {
			const scene = alertScene(columns, rows, 0, "acme-api");
			const keys = new Set();
			for (let row = 0; row < rows; row++) {
				for (let column = 0; column < columns; column++) {
					const uri = alertKey(scene, column, row);
					keys.add(uri);
					const info = await render(uri);
					assert.equal(info.width, 72);
				}
			}
			// Distinct windows onto the scene, not one image repeated.
			assert.ok(keys.size > columns * rows / 2, `${columns}x${rows}`);
		}
		assert.notEqual(alertScene(8, 4, 0), alertScene(8, 4, 1), "the frames differ, so Clawd waves");
	});

	it("renders the decorations", async () => {
		await render(tile({ tone: "accent", glyph: "+", title: "Queue", badge: 3 }));
		await render(tile({ tone: "working", glyph: "▶", title: "Working", progress: 0.42 }));
		await render(tile({ tone: "error", headline: "All tools", edge: "standby", subtitle: "press to switch" }));
		await render(tile({ tone: "idle", glyph: "✓", title: "Allow", solid: true, eyebrow: "allow · 30s" }));
		await render(tile({ tone: "offline" }));
	});

	it("survives text that would otherwise break the markup", async () => {
		const nasty = `<script>alert("x")</script> & 'quotes' "more"`;
		const dataUri = tile({ tone: "accent", glyph: "!", title: nasty, subtitle: nasty, eyebrow: nasty, badge: nasty });

		const svg = Buffer.from(dataUri.split(",")[1], "base64").toString("utf8");
		assert.ok(!svg.includes("<script>"), "markup from settings must be escaped");

		await render(dataUri);
	});

	it("renders long prompts without overflowing the key", async () => {
		const long = "Run the entire integration test suite and then fix every single failure you find";
		await render(tile({ tone: "accent", glyph: "+", title: long, subtitle: long }));

		assert.equal(fit(long, 13).length, 2, "a long label is folded onto two lines");
		assert.ok(fit(long, 13).every((line) => line.length <= 14));
	});
});

describe("formatting", () => {
	it("formats durations the way a key has room for", () => {
		assert.equal(duration(8_000), "8s");
		assert.equal(duration(252_000), "4:12");
		assert.equal(duration(3_852_000), "1:04:12");
		assert.equal(duration(-5), "0s");
	});

	it("formats token counts compactly", () => {
		assert.equal(compactNumber(940), "940");
		assert.equal(compactNumber(12_400), "12k");
		assert.equal(compactNumber(1_240_000), "1.2M");
		assert.equal(compactNumber(115_040_000), "115M");
		assert.equal(compactNumber(1_420_000_000), "1.4B");
	});
});
