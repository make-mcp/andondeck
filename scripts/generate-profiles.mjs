/**
 * Generates the ready-made Stream Deck profiles that ship with the plugin.
 *
 * A profile is the difference between "nine actions, arrange them yourself" and
 * a working control surface on first launch, so each supported device gets a
 * layout designed for its grid rather than a cropped version of a bigger one.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { makeZip } from "./lib/zip.mjs";

/**
 * Key art for a typed slash command, in the plugin's own tile style so the
 * native keys do not look borrowed.
 */
async function typedArtwork({ command, label }) {
	const font = "'Segoe UI','DejaVu Sans',sans-serif";
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 72 72">
		<rect width="72" height="72" fill="#201E1C"/>
		<rect x="1" y="1" width="70" height="70" rx="8" fill="none" stroke="#B9B2A8" stroke-opacity=".55" stroke-width="2"/>
		<text x="36" y="21" font-family="${font}" font-size="9" font-weight="600" fill="#948E86" text-anchor="middle">TYPES</text>
		<text x="36" y="42" font-family="${font}" font-size="${Math.min(14, 58 / (0.72 * command.length)).toFixed(1)}" font-weight="700" fill="#F2EFEA" text-anchor="middle">${command}</text>
		<text x="36" y="58" font-family="${font}" font-size="9" fill="#948E86" text-anchor="middle">${label}</text>
	</svg>`;
	return sharp(Buffer.from(svg)).png().toBuffer();
}

const PLUGIN = "io.github.claude-deck.plugin";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Beside the manifest, not in a subfolder: that is where Elgato's own bundled
// profiles live, and it is the only arrangement confirmed to be picked up.
const outDir = join(root, `${PLUGIN}.sdPlugin`);

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
	alert: `${PLUGIN}.alert`,
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
		FontFamily: "",
		FontSize: 10,
		FontStyle: "",
		FontUnderline: false,
		OutlineThickness: 2,
		// The plugin draws its own words onto the key; a title would sit on top.
		ShowTitle: false,
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
const ALWAYS = key(A.approve, "Always allow", { verdict: "always" });
const HALT = key(A.halt, "Stop Claude", { clearQueue: false });
const AUTO_SAFE = key(A.autopilot, "Autopilot", { scope: "safe", minutes: 15 });
const AUTO_ALL = key(A.autopilot, "Autopilot", { scope: "all", minutes: 10 });
const MODEL = key(A.model, "Model");

const TIMER = key(A.usage, "Turn timer", { metric: "turn" });
const CONTEXT = key(A.usage, "Context", { metric: "context" });
const TOKENS = key(A.usage, "Tokens", { metric: "tokens" });
const PLAN_5H = key(A.usage, "5h limit", { metric: "plan5h" });
const PLAN_WEEK = key(A.usage, "Week limit", { metric: "planWeek" });
const TODAY = key(A.usage, "Today", { metric: "today" });
const WEEK = key(A.usage, "7 days", { metric: "week" });

// Browse on a dial (rotate, press to move up); on a key the same entry means "newest next".
const PROMOTE = key(A.queueControl, "Promote", { mode: "browse" });
const DROP = key(A.queueControl, "Drop next", { mode: "drop-next" });
const CLEAR = key(A.queueControl, "Clear queue", { mode: "clear" });

/**
 * A key that types a slash command into the focused terminal.
 *
 * Claude Code runs slash commands only from its own input line — no hook can
 * trigger one — so these use Stream Deck's built-in Text action rather than
 * this plugin. Settings mirror what Stream Deck itself writes for that action.
 */
const TEXT_PLUGIN = { Name: "Text", UUID: "com.elgato.streamdeck.system.text", Version: "1.0" };
const typed = (command, label) => ({
	...key(TEXT_PLUGIN.UUID, "Text", {
		Hotkey: { KeyModifiers: 0, QTKeyCode: 33554431, VKeyCode: -1 },
		isSendingEnter: true,
		isTypingMode: true,
		pastedText: command,
	}),
	Plugin: TEXT_PLUGIN,
	artwork: { command, label },
});

const COMPACT = typed("/compact", "Compact");
const CONTEXT_GRID = typed("/context", "Context map");
// Opens Claude Code's own model picker; the Model key beside it shows the current one.
const MODEL_PICK = typed("/model", "Pick model");
const CONTINUE = queue("Continue", "Continue where you left off.");

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
		name: "Andon Deck",
		deviceType: 0,
		model: "20GBA9901",
		controllers: [
			{
				Type: "Keypad",
				Actions: grid([
					[SLOT(1), SLOT(2), SLOT(3), CONTEXT, PLAN_5H],
					[ALLOW, DENY, HALT, AUTO_SAFE, MODEL],
					[Q_TESTS, CLEAR, LAUNCH("Project"), COMPACT, SETUP],
				]),
			},
		],
	},
	{
		name: "Andon Deck Mini",
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
		name: "Andon Deck XL",
		deviceType: 2,
		model: "20GAT9901",
		controllers: [
			{
				Type: "Keypad",
				Actions: grid([
					[SLOT(1), SLOT(2), SLOT(3), SLOT(4), CONTEXT, PLAN_5H, PLAN_WEEK, WEEK],
					[ALLOW, ALWAYS, DENY, HALT, AUTO_SAFE, MODEL, MODEL_PICK, CONTEXT_GRID],
					[Q_TESTS, Q_REVIEW, Q_COMMIT, Q_DOCS, Q_CLIP, PROMOTE, DROP, CLEAR],
					[LAUNCH("Project 1"), LAUNCH("Project 2"), RUN_REVIEW, RUN_TODAY, COMPACT, CONTINUE, AUTO_ALL, SETUP],
				]),
			},
		],
	},
	{
		name: "Andon Deck Plus",
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
				Actions: grid([[PROMOTE, SESSION, CONTEXT, PLAN_5H]]),
			},
		],
	},
	{
		// Model and grid copied from Elgato's own Volume Controller "+ XL" profile.
		name: "Andon Deck Plus XL",
		deviceType: 13,
		model: "20GBX9901",
		controllers: [
			{
				Type: "Keypad",
				Actions: grid([
					[SLOT(1), SLOT(2), SLOT(3), SLOT(4), TIMER, CONTEXT, PLAN_5H, PLAN_WEEK, TOKENS],
					[ALLOW, ALWAYS, DENY, HALT, AUTO_SAFE, AUTO_ALL, MODEL, MODEL_PICK, CONTEXT_GRID],
					[Q_TESTS, Q_REVIEW, Q_COMMIT, Q_DOCS, Q_CLIP, PROMOTE, DROP, CLEAR, CONTINUE],
					[LAUNCH("Project 1"), LAUNCH("Project 2"), LAUNCH("Project 3"), RUN_REVIEW, RUN_TODAY, COMPACT, TODAY, WEEK, SETUP],
				]),
			},
			{
				Type: "Encoder",
				Actions: grid([[PROMOTE, SESSION, CONTEXT, PLAN_5H, PLAN_WEEK, WEEK]]),
			},
		],
	},
	{
		// Model, grid and dial positions copied from Elgato's own Volume Controller "Galleon" profile.
		name: "Andon Deck Galleon",
		deviceType: 12,
		model: "GRETSCH",
		controllers: [
			{
				Type: "Keypad",
				Actions: grid([
					[STATUS, CONTEXT, PLAN_5H],
					[ALLOW, DENY, HALT],
					[Q_TESTS, COMPACT, AUTO_SAFE],
					[LAUNCH("Project"), CLEAR, SETUP],
				]),
			},
			{
				Type: "Encoder",
				Actions: grid([[PROMOTE, SESSION]]),
			},
		],
	},
	{
		// Grid from the SDK's description (16 x 2 keys, a dial each side). No
		// Elgato profile for the Studio was available to copy the model from.
		name: "Andon Deck Studio",
		deviceType: 10,
		model: "20GBO9901",
		controllers: [
			{
				Type: "Keypad",
				Actions: grid([
					[SLOT(1), SLOT(2), SLOT(3), SLOT(4), TIMER, CONTEXT, PLAN_5H, PLAN_WEEK, ALLOW, ALWAYS, DENY, HALT, AUTO_SAFE, MODEL, CONTEXT_GRID, SETUP],
					[Q_TESTS, Q_REVIEW, Q_COMMIT, Q_DOCS, Q_CLIP, PROMOTE, DROP, CLEAR, LAUNCH("Project 1"), LAUNCH("Project 2"), RUN_REVIEW, RUN_TODAY, COMPACT, CONTINUE, AUTO_ALL, WEEK],
				]),
			},
			{
				Type: "Encoder",
				Actions: grid([[PROMOTE, SESSION]]),
			},
		],
	},
	{
		// Three pedals, no screens: the three things worth doing with your feet.
		// Model per Stream Deck's hardware table; no Elgato pedal profile to copy.
		name: "Andon Deck Pedal",
		deviceType: 5,
		model: "20GBF9901",
		controllers: [
			{
				Type: "Keypad",
				Actions: grid([[ALLOW, HALT, DENY]]),
			},
		],
	},
	{
		name: "Andon Deck Neo",
		deviceType: 9,
		model: "20GBJ9901",
		controllers: [
			{
				Type: "Keypad",
				Actions: grid([
					[STATUS, ALLOW, DENY, HALT],
					[Q_TESTS, COMPACT, AUTO_SAFE, SETUP],
				]),
			},
		],
	},
	{
		// Stream Deck Mobile picks its grid on the phone; 5 x 3 is the layout it
		// starts with. Model as Stream Deck itself names the Wi-Fi client.
		name: "Andon Deck Mobile",
		deviceType: 3,
		model: "VSD/WiFi",
		controllers: [
			{
				Type: "Keypad",
				Actions: grid([
					[SLOT(1), SLOT(2), CONTEXT, PLAN_5H, WEEK],
					[ALLOW, DENY, HALT, AUTO_SAFE, MODEL],
					[Q_TESTS, CLEAR, COMPACT, CONTINUE, SETUP],
				]),
			},
		],
	},
	{
		// The on-screen Virtual Stream Deck scales from 1 to 8 x 8 keys. This
		// fills the 4 x 4 corner, so it reads whole at any size from there up.
		// Model as Elgato's own on-screen profiles carry it (StreamDeck.exe
		// calls this device ESDUiStreamDeck).
		name: "Andon Deck Virtual",
		deviceType: 11,
		model: "UI Stream Deck",
		controllers: [
			{
				Type: "Keypad",
				Actions: grid([
					[STATUS, CONTEXT, PLAN_5H, WEEK],
					[ALLOW, ALWAYS, DENY, HALT],
					[Q_TESTS, CLEAR, COMPACT, AUTO_SAFE],
					[LAUNCH("Project"), CONTINUE, MODEL, SETUP],
				]),
			},
		],
	},
];

/** Keys across and down per device type, for filling an alert profile. */
const KEY_GRID = { 0: [5, 3], 1: [3, 2], 2: [8, 4], 3: [5, 3], 7: [4, 2], 9: [4, 2], 10: [16, 2], 11: [8, 8], 12: [3, 4], 13: [9, 4] };

/**
 * One alert profile per device with screens: every key is the alert action,
 * which draws its own piece of the full-deck Clawd. Dials stay empty.
 */
const ALERTS = DEVICES.filter((device) => KEY_GRID[device.deviceType]).map((device) => {
	const [columns, rows] = KEY_GRID[device.deviceType];
	const ALERT = key(A.alert, "Alert");
	return {
		...device,
		name: `${device.name} Alert`,
		controllers: device.controllers.map((controller) =>
			controller.Type === "Keypad"
				? { Type: "Keypad", Actions: grid(Array.from({ length: rows }, () => Array.from({ length: columns }, () => ALERT))) }
				: { Type: controller.Type, Actions: {} },
		),
	};
});

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

const manifestPath = join(root, `${PLUGIN}.sdPlugin`, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const plugin = { Name: manifest.Name, UUID: PLUGIN, Version: manifest.Version };

/**
 * Stream Deck 7 profile format ("ProfilesV3").
 *
 * The layout is copied from a bundled profile that Stream Deck 7.4 demonstrably
 * installed on a real deck: a `package.json` at the root, the profile under
 * `Profiles/`, page folders named by UUID, an empty default page beside the
 * real one, and a per-key `ActionID` plus `Plugin` block. The older 6.x layout
 * this generator used to write was silently ignored.
 */
for (const device of [...DEVICES, ...ALERTS]) {
	const id = async (what) => asUuid(await stableId(`${PLUGIN}:${device.name}:${what}`, 32));
	const profileId = await id("profile");
	const pageId = await id("page");
	const defaultPageId = await id("default-page");
	const base = `Profiles/${profileId}.sdProfile`;

	const outer = {
		Device: { Model: device.model, UUID: (await id("device")).toLowerCase() },
		Name: device.name,
		Pages: {
			Current: "00000000-0000-0000-0000-000000000000",
			Default: defaultPageId.toLowerCase(),
			Pages: [pageId.toLowerCase()],
		},
		Version: "3.0",
	};

	const images = [];
	const withIds = async (controller) => {
		const actions = {};
		for (const [coordinates, entry] of Object.entries(controller.Actions)) {
			let states = entry.States;
			if (entry.artwork) {
				const file = `${await stableId(`${device.name}:${coordinates}:image`, 27)}.png`;
				images.push({ path: `${base}/Profiles/${pageId}/Images/${file}`, data: await typedArtwork(entry.artwork) });
				states = states.map((state) => ({ ...state, Image: `Images/${file}` }));
			}

			actions[coordinates] = {
				ActionID: (await id(`action:${controller.Type}:${coordinates}`)).toLowerCase(),
				LinkedTitle: true,
				Name: entry.Name,
				Plugin: entry.Plugin ?? plugin,
				Resources: null,
				Settings: entry.Settings,
				State: entry.State,
				States: states,
				UUID: entry.UUID,
			};
		}
		return { Actions: Object.keys(actions).length ? actions : null, Type: controller.Type };
	};

	const page = { Controllers: await Promise.all(device.controllers.map(withIds)), Icon: "", Name: "" };
	const blank = {
		Controllers: device.controllers.map((controller) => ({ Actions: null, Type: controller.Type })),
		Icon: "",
		Name: "",
	};

	const packageInfo = {
		AppVersion: "7.0.0.0",
		DeviceModel: device.model,
		DeviceSettings: null,
		FormatVersion: 1,
		OSType: "Windows",
		OSVersion: "10.0.0",
		RequiredPlugins: [PLUGIN, ...(images.length ? [TEXT_PLUGIN.UUID] : [])],
	};

	const zip = makeZip([
		{ path: "Profiles/" },
		{ path: `${base}/` },
		{ path: `${base}/Images/` },
		{ path: `${base}/Profiles/` },
		{ path: `${base}/Profiles/${defaultPageId}/` },
		{ path: `${base}/Profiles/${defaultPageId}/Images/` },
		{ path: `${base}/Profiles/${pageId}/` },
		{ path: `${base}/Profiles/${pageId}/Images/` },
		{ path: "package.json", data: JSON.stringify(packageInfo) },
		{ path: `${base}/manifest.json`, data: JSON.stringify(outer) },
		{ path: `${base}/Profiles/${defaultPageId}/manifest.json`, data: JSON.stringify(blank) },
		{ path: `${base}/Profiles/${pageId}/manifest.json`, data: JSON.stringify(page) },
		...images,
	]);

	await writeFile(join(outDir, `${device.name}.streamDeckProfile`), zip);
	const keys = device.controllers.reduce((total, c) => total + Object.keys(c.Actions ?? {}).length, 0);
	console.log(`profile ${device.name.padEnd(18)} type=${device.deviceType} ${keys} actions`);
}

// Keep the manifest's Profiles list in step with what was generated.
manifest.Profiles = [...DEVICES, ...ALERTS].map((device) => ({
	Name: device.name,
	DeviceType: device.deviceType,
	Readonly: false,
	DontAutoSwitchWhenInstalled: true,
	AutoInstall: true,
}));
await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
console.log(`manifest updated with ${manifest.Profiles.length} profiles`);
