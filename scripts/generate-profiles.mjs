/**
 * Generates the ready-made Stream Deck profiles that ship with the plugin.
 *
 * A profile is the difference between "nine actions, arrange them yourself" and
 * a working control surface on first launch, so each supported device gets a
 * layout designed for its grid rather than a cropped version of a bigger one.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeZip } from "./lib/zip.mjs";

const PLUGIN = "io.github.claude-deck.plugin";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, `${PLUGIN}.sdPlugin`, "profiles");

const A = {
	status: `${PLUGIN}.status`,
	queue: `${PLUGIN}.queue`,
	queueControl: `${PLUGIN}.queue-control`,
	approve: `${PLUGIN}.approve`,
	prompt: `${PLUGIN}.prompt`,
	session: `${PLUGIN}.session`,
	headless: `${PLUGIN}.headless`,
	usage: `${PLUGIN}.usage`,
	slot: `${PLUGIN}.slot`,
	launch: `${PLUGIN}.launch`,
	autopilot: `${PLUGIN}.autopilot`,
	halt: `${PLUGIN}.halt`,
	model: `${PLUGIN}.model`,
	setup: `${PLUGIN}.setup`,
};

/** Number of states each action declares in the plugin manifest. */
const STATE_COUNT = {
	[A.approve]: 2,
	[A.headless]: 2,
	[A.setup]: 2,
	[A.autopilot]: 2,
	[A.halt]: 2,
};

/**
 * Builds one key or dial entry.
 * @param uuid Action UUID.
 * @param name Display name in the Stream Deck UI.
 * @param settings Action settings.
 * @returns The entry.
 */
function key(uuid, name, settings = {}) {
	const states = Array.from({ length: STATE_COUNT[uuid] ?? 1 }, () => ({
		FontSize: 10,
		FontUnderline: false,
		Image: "",
		TitleAlignment: "bottom",
		TitleColor: "#ffffff",
	}));

	return { Name: name, Settings: settings, State: 0, States: states, UUID: uuid };
}

// Prompts chosen to be useful in any repository, not just a specific stack.
const queue = (label, text) => key(A.queue, "Queue Prompt", { text, label });

const Q_TESTS = queue("Run tests", "Run the test suite and fix anything that fails.");
const Q_REVIEW = queue("Review", "Review what you just changed and flag anything risky.");
const Q_COMMIT = queue("Commit", "Commit the current changes with a clear message.");
const Q_DOCS = queue("Docs", "Update the docs to match the changes you just made.");
const Q_CLIP = key(A.queue, "Queue Prompt", { source: "clipboard", label: "Clipboard" });

const SLOT = (index) => key(A.slot, `Session ${index}`, { index, press: "pin" });
const STATUS = key(A.status, "Claude Status", { showTool: true });
const SESSION = key(A.session, "Session", { mode: "cycle" });

const ALLOW = key(A.approve, "Approve", { verdict: "allow" });
const DENY = key(A.approve, "Deny", { verdict: "deny" });
const HALT = key(A.halt, "Stop Claude", { clearQueue: false });
const AUTO_SAFE = key(A.autopilot, "Autopilot", { scope: "safe", minutes: 15 });
const AUTO_ALL = key(A.autopilot, "Autopilot", { scope: "all", minutes: 10 });
const MODEL = key(A.model, "Model");

const TIMER = key(A.usage, "Turn timer", { metric: "turn" });
const CONTEXT = key(A.usage, "Context", { metric: "context" });
const TOKENS = key(A.usage, "Tokens", { metric: "tokens" });
const TOOLS = key(A.usage, "Tool calls", { metric: "tools" });

const PROMOTE = key(A.queueControl, "Promote", { mode: "browse" });
const DROP = key(A.queueControl, "Drop next", { mode: "drop-next" });
const CLEAR = key(A.queueControl, "Clear queue", { mode: "clear" });

const COMPACT = key(A.prompt, "Compact", { preset: "compact" });
const CONTINUE = key(A.prompt, "Continue", { preset: "continue" });

// Launchers ship without a folder; the key says so until one is set.
const LAUNCH = (label) => key(A.launch, "Launch Claude", { label });
const RUN_REVIEW = key(A.headless, "Run Task", {
	prompt: "Review the current git diff and list anything risky in a few bullets.",
	label: "Review diff",
	timeoutSec: 300,
});
const RUN_TODAY = key(A.headless, "Run Task", {
	prompt: "Summarise what changed in this repository today.",
	label: "Today",
	timeoutSec: 300,
});
const SETUP = key(A.setup, "Connect Claude Code");

/**
 * Turns a grid of rows into the coordinate map a profile page expects.
 * @param rows Rows of entries, `null` for a deliberate gap.
 * @returns The map.
 */
function grid(rows) {
	const actions = {};
	rows.forEach((row, y) => {
		row.forEach((entry, x) => {
			if (entry) {
				actions[`${x},${y}`] = entry;
			}
		});
	});
	return actions;
}

/**
 * Device layouts.
 *
 * Rows are tasks, not categories: watch what is happening, answer it, line up
 * what comes next, start something new. Reading down a column is meaningless;
 * reading along a row is how the deck is actually used.
 */
const DEVICES = [
	{
		name: "Claude Deck",
		deviceType: 0,
		model: "20GBA9901",
		controllers: [
			{
				Type: "Keypad",
				Actions: grid([
					[SLOT(1), SLOT(2), SLOT(3), TIMER, CONTEXT],
					[ALLOW, DENY, HALT, AUTO_SAFE, MODEL],
					[Q_TESTS, CLEAR, LAUNCH("Project"), COMPACT, SETUP],
				]),
			},
		],
	},
	{
		name: "Claude Deck Mini",
		deviceType: 1,
		model: "20GAI9901",
		controllers: [
			{
				Type: "Keypad",
				Actions: grid([
					[STATUS, ALLOW, DENY],
					[HALT, Q_TESTS, SETUP],
				]),
			},
		],
	},
	{
		name: "Claude Deck XL",
		deviceType: 2,
		model: "20GAT9901",
		controllers: [
			{
				Type: "Keypad",
				Actions: grid([
					[SLOT(1), SLOT(2), SLOT(3), SLOT(4), TIMER, CONTEXT, TOKENS, TOOLS],
					[ALLOW, DENY, HALT, AUTO_SAFE, AUTO_ALL, MODEL, SESSION, STATUS],
					[Q_TESTS, Q_REVIEW, Q_COMMIT, Q_DOCS, Q_CLIP, PROMOTE, DROP, CLEAR],
					[LAUNCH("Project 1"), LAUNCH("Project 2"), RUN_REVIEW, RUN_TODAY, COMPACT, CONTINUE, null, SETUP],
				]),
			},
		],
	},
	{
		name: "Claude Deck Plus",
		deviceType: 7,
		model: "20GBD9901",
		controllers: [
			{
				Type: "Keypad",
				Actions: grid([
					[STATUS, ALLOW, DENY, HALT],
					[LAUNCH("Project"), Q_TESTS, AUTO_SAFE, SETUP],
				]),
			},
			{
				Type: "Encoder",
				Actions: grid([[PROMOTE, SESSION, TIMER, CONTEXT]]),
			},
		],
	},
	{
		name: "Claude Deck Neo",
		deviceType: 9,
		model: "20GBJ9901",
		controllers: [
			{ Type: "Neo", Actions: {} },
			{
				Type: "Keypad",
				Actions: grid([
					[STATUS, ALLOW, DENY, HALT],
					[Q_TESTS, COMPACT, AUTO_SAFE, SETUP],
				]),
			},
		],
	},
];

/**
 * Derives a stable identifier from a name.
 *
 * Stream Deck only needs these to be unique; deriving them keeps regenerated
 * profiles byte-identical instead of churning random UUIDs into git.
 * @param seed Text to derive from.
 * @param length How many characters to produce.
 * @returns An uppercase hex-ish identifier.
 */
async function stableId(seed, length) {
	const { createHash } = await import("node:crypto");
	return createHash("sha256").update(seed).digest("hex").toUpperCase().slice(0, length);
}

/** Formats a derived id as a UUID, which is the shape Stream Deck writes. */
function asUuid(hex) {
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

await mkdir(outDir, { recursive: true });

for (const device of DEVICES) {
	const profileId = asUuid(await stableId(`${PLUGIN}:${device.name}:profile`, 32));
	const pageId = asUuid(await stableId(`${PLUGIN}:${device.name}:page`, 32));
	const pageDir = await stableId(`${PLUGIN}:${device.name}:dir`, 26);
	const base = `${profileId}.sdProfile`;

	const outer = {
		Device: { Model: device.model, UUID: "" },
		InstalledByPluginUUID: PLUGIN,
		Name: device.name,
		Pages: { Current: pageId, Pages: [pageId] },
		PreconfiguredName: device.name,
		Version: "2.0",
	};

	const page = { Controllers: device.controllers };

	const zip = makeZip([
		{ path: `${base}/` },
		{ path: `${base}/manifest.json`, data: JSON.stringify(outer, null, 2) },
		{ path: `${base}/Profiles/` },
		{ path: `${base}/Profiles/${pageDir}/` },
		{ path: `${base}/Profiles/${pageDir}/Images/` },
		{ path: `${base}/Profiles/${pageDir}/manifest.json`, data: JSON.stringify(page, null, 2) },
	]);

	await writeFile(join(outDir, `${device.name}.streamDeckProfile`), zip);
	const keys = device.controllers.reduce((total, c) => total + Object.keys(c.Actions).length, 0);
	console.log(`profile ${device.name.padEnd(18)} type=${device.deviceType} ${keys} actions`);
}

// Keep the manifest's Profiles list in step with what was generated.
const manifestPath = join(root, `${PLUGIN}.sdPlugin`, "manifest.json");
const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(manifestPath, "utf8"));
manifest.Profiles = DEVICES.map((device) => ({
	Name: `profiles/${device.name}`,
	DeviceType: device.deviceType,
	Readonly: false,
	DontAutoSwitchWhenInstalled: true,
	AutoInstall: false,
}));
await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
console.log(`manifest updated with ${manifest.Profiles.length} profiles`);
