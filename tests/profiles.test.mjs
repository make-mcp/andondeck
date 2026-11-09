import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { describe, it } from "node:test";

import { ALERT_PROFILE_FOR_DEVICE, PROFILE_FOR_DEVICE } from "../.test-build/profiles.js";

const DIR = new URL("../com.andondeck.plugin.sdPlugin/", import.meta.url);

/** Reads every file from a ZIP archive (stored or deflated). */
function unzip(buffer) {
	const files = new Map();
	let offset = 0;
	while (buffer.readUInt32LE(offset) === 0x04034b50) {
		const method = buffer.readUInt16LE(offset + 8);
		const size = buffer.readUInt32LE(offset + 18);
		const nameLength = buffer.readUInt16LE(offset + 26);
		const extraLength = buffer.readUInt16LE(offset + 28);
		const name = buffer.toString("utf8", offset + 30, offset + 30 + nameLength);
		const start = offset + 30 + nameLength + extraLength;
		const data = buffer.subarray(start, start + size);
		files.set(name, method === 8 ? inflateRawSync(data) : data);
		offset = start + size;
	}
	return files;
}

const manifest = JSON.parse(await readFile(new URL("manifest.json", DIR), "utf8"));

/** Grid of each device type, from the Stream Deck SDK's own descriptions. */
// Mobile is checked against the 5 x 3 grid it starts with, Virtual against its 8 x 8 maximum.
const GRIDS = { 0: [5, 3], 1: [3, 2], 2: [8, 4], 3: [5, 3], 5: [3, 1], 7: [4, 2], 9: [4, 2], 10: [16, 2], 11: [8, 8], 12: [3, 4], 13: [9, 4] };

describe("bundled profiles", () => {
	it("covers every Stream Deck with screens or pedals", () => {
		assert.deepEqual(
			manifest.Profiles.filter((p) => !p.Name.endsWith(" Alert"))
				.map((p) => p.DeviceType)
				.sort((a, b) => a - b),
			Object.keys(GRIDS).map(Number),
		);
	});

	it("can switch to every bundled profile from the Connect key", () => {
		const of = (alert) => Object.fromEntries(manifest.Profiles.filter((p) => p.Name.endsWith(" Alert") === alert).map((p) => [p.DeviceType, p.Name]));
		const map = (table) => Object.fromEntries(Object.entries(table).map(([type, name]) => [Number(type), name]));
		assert.deepEqual(of(false), map(PROFILE_FOR_DEVICE));
		assert.deepEqual(of(true), map(ALERT_PROFILE_FOR_DEVICE));
	});

	it("fills every key of an alert profile, and only with the alert", async () => {
		for (const entry of manifest.Profiles.filter((p) => p.Name.endsWith(" Alert"))) {
			const files = unzip(await readFile(new URL(`${entry.Name}.streamDeckProfile`, DIR)));
			const [columns, rows] = GRIDS[entry.DeviceType];
			const pages = [...files.keys()].filter((n) => /\/Profiles\/[^/]+\/manifest\.json$/.test(n)).map((n) => JSON.parse(files.get(n)));
			const keypad = pages.flatMap((page) => page.Controllers).find((c) => c.Type === "Keypad" && c.Actions);
			const actions = Object.values(keypad.Actions);
			assert.equal(actions.length, columns * rows, entry.Name);
			assert.ok(actions.every((a) => a.UUID === "com.andondeck.plugin.alert"), entry.Name);
		}
	});

	for (const entry of manifest.Profiles) {
		it(`${entry.Name} is in Stream Deck 7's format and fits its device`, async () => {
			const files = unzip(await readFile(new URL(`${entry.Name}.streamDeckProfile`, DIR)));
			const pkg = JSON.parse(files.get("package.json"));
			assert.deepEqual(pkg.RequiredPlugins.includes("com.andondeck.plugin"), true);

			const outerName = [...files.keys()].find((n) => /^Profiles\/[^/]+\.sdProfile\/manifest\.json$/.test(n));
			const outer = JSON.parse(files.get(outerName));
			assert.equal(outer.Version, "3.0");
			assert.equal(outer.Device.Model, pkg.DeviceModel);

			const pages = [...files.keys()].filter((n) => /\/Profiles\/[^/]+\/manifest\.json$/.test(n));
			assert.equal(pages.length, 2, "a default page and the layout");

			const [columns, rows] = GRIDS[entry.DeviceType];
			for (const page of pages) {
				for (const controller of JSON.parse(files.get(page)).Controllers) {
					for (const [coordinates, action] of Object.entries(controller.Actions ?? {})) {
						const [x, y] = coordinates.split(",").map(Number);
						if (controller.Type === "Keypad") {
							assert.ok(x < columns && y < rows, `${coordinates} is off a ${columns}x${rows} grid`);
						}
						const image = action.States[0].Image;
						if (image) {
							assert.ok(files.has(page.replace("manifest.json", image)), `missing ${image}`);
						}
						if (action.UUID.startsWith("com.andondeck.plugin.")) {
							const declared = manifest.Actions.find((a) => a.UUID === action.UUID);
							assert.ok(declared, `${action.UUID} is not in the manifest`);
							assert.ok((declared.Controllers ?? ["Keypad"]).includes(controller.Type), `${action.UUID} on ${controller.Type}`);
						}
					}
				}
			}
		});
	}
});
