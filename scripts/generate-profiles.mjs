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
const QUEUE_TESTS = key(A.queue, "Queue Prompt", {
	text: "Run the test suite and fix anything that fails.",
	label: "Run tests",
});
const QUEUE_REVIEW = key(A.queue, "Queue Prompt", {
	text: "Review what you just changed and flag anything risky.",
	label: "Review",
});
const QUEUE_COMMIT = key(A.queue, "Queue Prompt", {
	text: "Commit the current changes with a clear message.",
	label: "Commit",
});
const QUEUE_DOCS = key(A.queue, "Queue Prompt", {
	text: "Update the docs to match the changes you just made.",
	label: "Docs",
});

const ALLOW = key(A.approve, "Approve", { verdict: "allow" });
const DENY = key(A.approve, "Deny", { verdict: "deny", confirm: false });
const STATUS = key(A.status, "Claude Status", { showTool: true });
const SETUP = key(A.setup, "Connect Claude Code");
const CLEAR = key(A.queueControl, "Clear queue", { mode: "clear" });

const COMPACT = key(A.prompt, "Compact", { preset: "compact" });
const CONTINUE = key(A.prompt, "Continue", { preset: "continue" });
const EXPLAIN = key(A.prompt, "Explain", { preset: "explain" });
const SUMMARIZE = key(A.prompt, "Summarize", { preset: "summarize" });

const TIMER = key(A.usage, "Turn timer", { metric: "turn" });
const CONTEXT = key(A.usage, "Context", { metric: "context" });
const SESSION = key(A.session, "Session", { mode: "cycle" });

const HALT = key(A.halt, "Stop Claude", { clearQueue: false });
const AUTOPILOT = key(A.autopilot, "Autopilot", { scope: "safe", minutes: 15 });
const MODEL = key(A.model, "Model");

const TASK_REVIEW = key(A.headless, "Run Task", {
	prompt: "Review the current git diff and list anything risky in a few bullets.",
	label: "Review diff",
	timeoutSec: 300,
});

/**
 * Device layouts.
 *
 * Coordinates are `column,row`. Omitted coordinates stay empty, which reads
 * better than filling every slot on the larger decks.
 */
const DEVICES = [
	{
		name: "Claude Deck",
		deviceType: 0,
		model: "20GBA9901",
		controllers: [
			{
				Type: "Keypad",
				Actions: {
					"0,0": STATUS,
					"1,0": QUEUE_TESTS,
					"2,0": QUEUE_REVIEW,
					"3,0": QUEUE_COMMIT,
					"4,0": CLEAR,
					"0,1": ALLOW,
					"1,1": DENY,
					"2,1": HALT,
					"3,1": COMPACT,
					"4,1": CONTINUE,
					"0,2": SESSION,
					"1,2": TIMER,
					"2,2": CONTEXT,
					"3,2": AUTOPILOT,
					"4,2": SETUP,
				},
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
				Actions: {
					"0,0": STATUS,
					"1,0": QUEUE_TESTS,
					"2,0": HALT,
					"0,1": ALLOW,
					"1,1": DENY,
					"2,1": SETUP,
				},
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
				Actions: {
					"0,0": STATUS,
					"1,0": QUEUE_TESTS,
					"2,0": QUEUE_REVIEW,
					"3,0": QUEUE_COMMIT,
					"4,0": QUEUE_DOCS,
					"5,0": key(A.queueControl, "Promote", { mode: "browse" }),
					"6,0": key(A.queueControl, "Drop next", { mode: "drop-next" }),
					"7,0": CLEAR,
					"0,1": ALLOW,
					"1,1": DENY,
					"2,1": COMPACT,
					"3,1": CONTINUE,
					"4,1": EXPLAIN,
					"5,1": SUMMARIZE,
					"6,1": key(A.prompt, "Commit", { preset: "commit" }),
					"7,1": key(A.prompt, "Review", { preset: "review" }),
					"0,2": SESSION,
					"1,2": TIMER,
					"2,2": CONTEXT,
					"3,2": key(A.usage, "Tokens", { metric: "tokens" }),
					"4,2": key(A.usage, "Tool calls", { metric: "tools" }),
					"5,2": TASK_REVIEW,
					"6,2": key(A.headless, "Run Task", {
						prompt: "Summarise what changed in this repository today.",
						label: "Today",
						timeoutSec: 300,
					}),
					"7,2": CLEAR,
					"0,3": HALT,
					"1,3": AUTOPILOT,
					"2,3": key(A.autopilot, "Autopilot", { scope: "all", minutes: 10 }),
					"3,3": MODEL,
					"4,3": key(A.queue, "Queue Prompt", { source: "clipboard", label: "Clipboard" }),
					"7,3": SETUP,
				},
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
				Actions: {
					"0,0": STATUS,
					"1,0": QUEUE_TESTS,
					"2,0": ALLOW,
					"3,0": DENY,
					"0,1": HALT,
					"1,1": COMPACT,
					"2,1": AUTOPILOT,
					"3,1": SETUP,
				},
			},
			{
				Type: "Encoder",
				Actions: {
					"0,0": key(A.queueControl, "Queue", { mode: "browse" }),
					"1,0": SESSION,
					"2,0": TIMER,
					"3,0": CONTEXT,
				},
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
				Actions: {
					"0,0": STATUS,
					"1,0": QUEUE_TESTS,
					"2,0": ALLOW,
					"3,0": DENY,
					"0,1": HALT,
					"1,1": COMPACT,
					"2,1": TIMER,
					"3,1": SETUP,
				},
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
