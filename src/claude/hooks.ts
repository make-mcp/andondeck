import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { claudeHome, userSettingsPath } from "./env.js";
import { HELPERS, helperPath, writeHelpers } from "./helpers.js";
import { shellQuote } from "./locate.js";
import type { ClaudeLocation } from "./env.js";

/** Marks the hook entries this plugin owns, so they can be removed again cleanly. */
export const HOOK_MARKER = "claude-deck";



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
	/** Absolute `node` for the idle-wake helper; falls back to a bare `node`. */
	nodeCommand?: string;
	/** Tee Claude Code's status line into the bridge, for plan limits. */
	planLimits?: boolean;
};

type StatusLine = { type?: string; command?: string; [key: string]: unknown };

function isOurStatusLine(statusLine: unknown): boolean {
	const command = (statusLine as StatusLine | undefined)?.command;
	return typeof command === "string" && command.includes("deck-statusline");
}

/**
 * The status line that was there before Claude Deck took the slot.
 *
 * Recorded once, the first time the slot is taken, in a file beside the
 * helpers rather than in `settings.json`, where an unknown key would make
 * Claude Code report the file as invalid.
 */
async function originalStatusLine(location: ClaudeLocation, current: unknown): Promise<StatusLine | undefined> {
	const file = join(location.dataDir, HELPERS.statusLineOriginal);

	if (isOurStatusLine(current)) {
		try {
			return (JSON.parse(await readFile(file, "utf8")) as StatusLine | null) ?? undefined;
		} catch {
			return undefined;
		}
	}

	await mkdir(location.dataDir, { recursive: true });
	await writeFile(file, `${JSON.stringify(current ?? null)}\n`, "utf8");
	return (current as StatusLine | undefined) ?? undefined;
}

/** The command that runs the status line tee, spelled for Claude Code's side. */
function statusLineCommand(options: HookInstallOptions): string {
	if (options.location.kind === "wsl" || process.platform !== "win32") {
		return `sh ${shellQuote(helperPath(options.location, "statusLine"))}`;
	}

	const script = helperPath(options.location, "statusLineNode").replace(/\\/g, "/");
	const node = (options.nodeCommand || "node").replace(/\\/g, "/");
	return `"${node}" "${script}"`;
}

/** Puts the user's own status line back, or removes the slot if there was none. */
async function restoreStatusLine(location: ClaudeLocation, settings: ClaudeSettings): Promise<void> {
	if (!isOurStatusLine(settings.statusLine)) {
		return;
	}

	const original = await originalStatusLine(location, settings.statusLine);
	if (original) {
		settings.statusLine = original;
	} else {
		delete settings.statusLine;
	}
}

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
		// Hooks run without a login shell, so a version-managed Node (nvm, fnm,
		// volta) is invisible to a bare `node`. On POSIX a generated wrapper
		// resolves it at run time, which also survives later Node upgrades.
		const viaWrapper = options.location.kind === "wsl" || process.platform !== "win32";

		hooks.Stop[0].hooks.push({
			type: "command",
			command: viaWrapper ? "sh" : options.nodeCommand || "node",
			args: [helperPath(options.location, viaWrapper ? "idleWakeWrapper" : "idleWake")],
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

	return (hook.args ?? []).some(
		(arg) => typeof arg === "string" && (arg.includes(HELPERS.idleWake) || arg.includes(HELPERS.idleWakeWrapper)),
	);
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

	// Keep the pristine file only; a later write must not overwrite the backup
	// with a copy that already contains our hooks.
	try {
		await copyFile(path, `${path}.claude-deck.bak`, constants.COPYFILE_EXCL);
	} catch {
		// Either there is nothing to back up yet, or a backup already exists.
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

	// Helpers are always written: the idle-wake hook is optional, but the
	// Claude runner and the connectivity probe are used by other features.
	const settings = stripHooks(await readSettings(path));
	const original = options.planLimits ? await originalStatusLine(options.location, settings.statusLine) : undefined;

	await writeHelpers({
		location: options.location,
		baseUrl: options.baseUrl,
		token: options.token,
		statusLineCommand: original?.command,
	});

	if (options.planLimits) {
		settings.statusLine = { ...(original ?? {}), type: "command", command: statusLineCommand(options) };
	} else {
		await restoreStatusLine(options.location, settings);
	}

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
export async function uninstallHooks(settingsPath?: string, location?: ClaudeLocation): Promise<string> {
	const path = settingsPath ?? userSettingsPath();
	const settings = stripHooks(await readSettings(path));
	if (location) {
		await restoreStatusLine(location, settings);
	}
	await writeSettings(path, settings);
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
 * Reads back the URL the installed hooks currently point at.
 * @param settingsPath Settings file to inspect.
 * @returns The base URL, or `undefined` when no Claude Deck hook is installed.
 */
export async function installedHookUrl(settingsPath: string): Promise<string | undefined> {
	const settings = await readSettings(settingsPath).catch(() => ({}) as ClaudeSettings);

	for (const groups of Object.values(settings.hooks ?? {})) {
		for (const group of groups) {
			for (const hook of group.hooks ?? []) {
				if (isOurs(hook) && typeof hook.url === "string") {
					return hook.url.replace(/\/hook$/, "");
				}
			}
		}
	}

	return undefined;
}

/** Convenience for diagnostics in the property inspector. */
export function settingsLocation(): { home: string; settings: string; projects: string } {
	const home = claudeHome();
	return { home, settings: userSettingsPath(), projects: join(home, "projects") };
}

/** Claude Code accepts an auto-compact window in this range, in tokens. */
export const AUTO_COMPACT_RANGE = { min: 100_000, max: 1_000_000 } as const;

/**
 * Sets Claude Code's own `autoCompactWindow` setting.
 *
 * Claude Code compacts on its own once a conversation reaches this many tokens;
 * there is no way for a hook to run `/compact`, so steering this threshold is
 * how the deck makes compaction happen earlier. Out-of-range values are
 * clamped to what Claude Code accepts.
 * @param path Settings file.
 * @param window Tokens, or `"auto"` for Claude Code's tuned default.
 * @returns The value written.
 */
export async function setAutoCompactWindow(path: string, window: number | "auto"): Promise<number | "auto"> {
	const value =
		window === "auto" ? "auto" : Math.min(AUTO_COMPACT_RANGE.max, Math.max(AUTO_COMPACT_RANGE.min, Math.round(window)));
	const settings = await readSettings(path);

	if (settings.autoCompactWindow === value) {
		return value;
	}

	settings.autoCompactWindow = value;
	await writeSettings(path, settings);
	return value;
}

/** Whether the status line slot currently runs the Claude Deck relay. */
export async function statusLineInstalled(settingsPath: string): Promise<boolean> {
	return isOurStatusLine((await readSettings(settingsPath)).statusLine);
}
