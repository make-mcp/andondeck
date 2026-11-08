import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { claudeHome, userSettingsPath } from "./env.js";
import type { ClaudeLocation } from "./env.js";

/** Marks the hook entries this plugin owns, so they can be removed again cleanly. */
export const HOOK_MARKER = "claude-deck";

/** Name of the generated helper that wakes an idle session. */
export const IDLE_WAKE_SCRIPT = "idle-wake.mjs";

/** Events the bridge subscribes to, with the timeout each one gets. */
const EVENTS: { name: string; timeoutSec: number }[] = [
	{ name: "SessionStart", timeoutSec: 5 },
	{ name: "SessionEnd", timeoutSec: 5 },
	{ name: "UserPromptSubmit", timeoutSec: 5 },
	{ name: "PreToolUse", timeoutSec: 5 },
	{ name: "PostToolUse", timeoutSec: 5 },
	{ name: "PostToolUseFailure", timeoutSec: 5 },
	{ name: "PermissionDenied", timeoutSec: 5 },
	{ name: "Notification", timeoutSec: 5 },
	{ name: "StopFailure", timeoutSec: 5 },
	{ name: "PreCompact", timeoutSec: 5 },
	{ name: "PostCompact", timeoutSec: 5 },
	{ name: "PostModelSwitch", timeoutSec: 5 },
	{ name: "SubagentStart", timeoutSec: 5 },
	{ name: "SubagentStop", timeoutSec: 5 },
];

type HookHandler = {
	type: string;
	command?: string;
	args?: string[];
	url?: string;
	headers?: Record<string, string>;
	allowedEnvVars?: string[];
	timeout?: number;
	onFailure?: string;
	[key: string]: unknown;
};

type HookGroup = {
	matcher?: string;
	hooks: HookHandler[];
};

type ClaudeSettings = {
	hooks?: Record<string, HookGroup[]>;
	[key: string]: unknown;
};

export type HookInstallOptions = {
	/** Base URL the hooks POST to, e.g. `http://127.0.0.1:38274`. */
	baseUrl: string;
	token: string;
	/** Seconds a permission request may wait for an answer from the deck. */
	approvalTimeoutSec: number;
	/** Hold permission requests open so a key can answer them. */
	deckApprovals: boolean;
	/** Let the deck wake an idle session with a queued prompt. */
	idleWake: boolean;
	/** Where Claude Code's configuration lives; resolved for WSL when needed. */
	location: ClaudeLocation;
};

/**
 * Builds the hook handler the bridge expects for one event.
 *
 * `onFailure: "continue"` is deliberate — if Stream Deck is closed, Claude Code
 * must carry on as if the plugin were never installed.
 * @param options Install options.
 * @param timeoutSec Timeout for this handler.
 * @returns The handler entry.
 */
function handler(options: HookInstallOptions, timeoutSec: number): HookHandler {
	return {
		type: "http",
		url: `${options.baseUrl.replace(/\/+$/, "")}/hook`,
		headers: {
			"X-Claude-Deck-Token": options.token,
			"X-Claude-Deck-Distro": "$WSL_DISTRO_NAME",
		},
		allowedEnvVars: ["WSL_DISTRO_NAME"],
		timeout: timeoutSec,
		onFailure: "continue",
		statusMessage: `${HOOK_MARKER}`,
	};
}

/** The complete `hooks` fragment Claude Deck owns. */
export function buildHooks(options: HookInstallOptions): Record<string, HookGroup[]> {
	const hooks: Record<string, HookGroup[]> = {};

	for (const { name, timeoutSec } of EVENTS) {
		hooks[name] = [{ hooks: [handler(options, timeoutSec)] }];
	}

	// Stop carries the queued prompt back into the turn, so give it room to answer.
	hooks.Stop = [{ hooks: [handler(options, 30)] }];

	if (options.idleWake) {
		// Once a turn has ended there is nothing left to block, so a background
		// hook long-polls the bridge and exits 2 to wake Claude back up.
		hooks.Stop[0].hooks.push({
			type: "command",
			command: "node",
			args: [`${options.location.dataDirForClaude}/${IDLE_WAKE_SCRIPT}`],
			async: true,
			asyncRewake: true,
			timeout: 600,
			onFailure: "continue",
			statusMessage: HOOK_MARKER,
		});
	}

	if (options.deckApprovals) {
		hooks.PermissionRequest = [{ hooks: [handler(options, options.approvalTimeoutSec + 15)] }];
	}

	return hooks;
}

function isOurs(hook: HookHandler): boolean {
	if (typeof hook.url === "string") {
		return hook.url.includes("/hook") && "X-Claude-Deck-Token" in (hook.headers ?? {});
	}

	return (hook.args ?? []).some((arg) => typeof arg === "string" && arg.includes(IDLE_WAKE_SCRIPT));
}

/** Drops every Claude Deck handler from a settings object, leaving others untouched. */
export function stripHooks(settings: ClaudeSettings): ClaudeSettings {
	if (!settings.hooks) {
		return settings;
	}

	for (const [event, groups] of Object.entries(settings.hooks)) {
		const kept = groups
			.map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook)) }))
			.filter((group) => group.hooks.length > 0);

		if (kept.length > 0) {
			settings.hooks[event] = kept;
		} else {
			delete settings.hooks[event];
		}
	}

	if (Object.keys(settings.hooks).length === 0) {
		delete settings.hooks;
	}

	return settings;
}

async function readSettings(path: string): Promise<ClaudeSettings> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as ClaudeSettings;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		throw new Error(`Could not read ${path}: ${(error as Error).message}`);
	}
}

/** Writes settings atomically, keeping a one-shot backup of the previous file. */
async function writeSettings(path: string, settings: ClaudeSettings): Promise<void> {
	await mkdir(dirname(path), { recursive: true });

	try {
		await copyFile(path, `${path}.claude-deck.bak`);
	} catch {
		// No previous settings file; nothing to back up.
	}

	const temp = `${path}.claude-deck.tmp`;
	await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	await rename(temp, path);
}

/**
 * Installs the Claude Deck hooks into Claude Code's settings.
 * @param options Install options.
 * @returns The path that was written.
 */
export async function installHooks(options: HookInstallOptions): Promise<string> {
	const path = options.location.settingsPath;

	if (options.idleWake) {
		await writeIdleWakeScript(options);
	}

	const settings = stripHooks(await readSettings(path));

	settings.hooks = { ...(settings.hooks ?? {}) };
	for (const [event, groups] of Object.entries(buildHooks(options))) {
		settings.hooks[event] = [...(settings.hooks[event] ?? []), ...groups];
	}

	await writeSettings(path, settings);
	return path;
}

/**
 * Removes the Claude Deck hooks again.
 * @param settingsPath Settings file to clean; defaults to the user-level one.
 * @returns The path that was written.
 */
export async function uninstallHooks(settingsPath?: string): Promise<string> {
	const path = settingsPath ?? userSettingsPath();
	await writeSettings(path, stripHooks(await readSettings(path)));
	return path;
}

/** Whether Claude Deck hooks are currently present in the settings file. */
export async function hooksInstalled(settingsPath?: string): Promise<boolean> {
	const settings = await readSettings(settingsPath ?? userSettingsPath());
	return Object.values(settings.hooks ?? {}).some((groups) =>
		groups.some((group) => (group.hooks ?? []).some(isOurs)),
	);
}

/**
 * Writes the helper that long-polls the bridge for a prompt to wake an idle
 * session with.
 *
 * It is generated rather than shipped because it has to live on the same
 * filesystem as Claude Code, which on Windows may be inside WSL.
 * @param options Install options.
 * @returns Path of the written script, as this process sees it.
 */
export async function writeIdleWakeScript(options: HookInstallOptions): Promise<string> {
	const target = join(options.location.dataDir, IDLE_WAKE_SCRIPT);
	await mkdir(options.location.dataDir, { recursive: true });

	const source = `// Generated by Claude Deck. Safe to delete; the plugin rewrites it on connect.
// Long-polls the Stream Deck bridge for a prompt queued while this session is
// idle, then exits 2 so Claude Code wakes up and acts on it.
const url = ${JSON.stringify(`${options.baseUrl.replace(/\/+$/, "")}/wait`)};
const token = ${JSON.stringify(options.token)};

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let sessionId;
try {
	sessionId = JSON.parse(raw || "{}").session_id;
} catch {
	process.exit(0);
}
if (!sessionId) process.exit(0);

let response;
try {
	response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", "x-claude-deck-token": token },
		body: JSON.stringify({ session_id: sessionId }),
	});
} catch {
	process.exit(0);
}

if (!response.ok) process.exit(0);
const { text } = await response.json().catch(() => ({}));
if (!text) process.exit(0);

process.stderr.write(String(text));
process.exit(2);
`;

	await writeFile(target, source, "utf8");
	return target;
}

/** Convenience for diagnostics in the property inspector. */
export function settingsLocation(): { home: string; settings: string; projects: string } {
	const home = claudeHome();
	return { home, settings: userSettingsPath(), projects: join(home, "projects") };
}
