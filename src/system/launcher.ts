import { spawn } from "node:child_process";

import type { ClaudeLocation } from "../claude/env.js";
import { HELPERS, helperPath } from "../claude/helpers.js";
import { shellQuote } from "../claude/locate.js";

export type LaunchRequest = {
	location: ClaudeLocation;
	/** Folder to start in, spelled the way Claude Code's side sees it. */
	cwd?: string;
	/** Resume the most recent conversation instead of starting fresh. */
	resume?: boolean;
	model?: string;
	permissionMode?: string;
	/** First prompt, handed over as Claude Code's opening message. */
	prompt?: string;
	/** Overrides the terminal; `{cmd}` is replaced with the command to run. */
	terminal?: string;
};

/** Arguments for the `claude` invocation itself. */
function claudeArgs(request: LaunchRequest): string[] {
	const args: string[] = [];

	if (request.resume) {
		args.push("--continue");
	}
	if (request.model) {
		args.push("--model", request.model);
	}
	if (request.permissionMode) {
		args.push("--permission-mode", request.permissionMode);
	}
	if (request.prompt?.trim()) {
		args.push(request.prompt.trim());
	}

	return args;
}

/**
 * Opens a terminal with an interactive Claude Code session.
 *
 * Everything else in the plugin observes sessions that already exist; this is
 * what lets a cold deck become useful, so it has to work without Windows
 * Terminal, without a login shell and without a configured PATH.
 * @param request What to start and where.
 * @returns An error message, or `undefined` when the terminal was launched.
 */
export async function launchClaude(request: LaunchRequest): Promise<string | undefined> {
	const args = claudeArgs(request);
	const { command, spawnArgs } = plan(request, args);

	try {
		const child = spawn(command, spawnArgs, {
			detached: true,
			stdio: "ignore",
			// A launcher that hides its own window would be useless.
			windowsHide: false,
			shell: false,
		});

		child.unref();
		return undefined;
	} catch (error) {
		return (error as Error).message;
	}
}

/**
 * Chooses how to open a terminal on this platform.
 * @param request The request.
 * @param args Arguments for `claude`.
 * @returns Command and arguments to spawn.
 */
function plan(request: LaunchRequest, args: string[]): { command: string; spawnArgs: string[] } {
	const { location, cwd } = request;

	if (location.kind === "wsl") {
		// `start` gives the session its own console window without requiring
		// Windows Terminal, which is not installed everywhere.
		const inner = [
			"wsl.exe",
			...(location.distro ? ["-d", location.distro] : []),
			...(cwd ? ["--cd", cwd] : []),
			"--",
			"sh",
			helperPath(location, "runClaude"),
			...args,
		];

		return { command: "cmd.exe", spawnArgs: ["/c", "start", "Claude Code", ...inner] };
	}

	if (process.platform === "win32") {
		const claude = ["claude.cmd", ...args].join(" ");
		return { command: "cmd.exe", spawnArgs: ["/c", "start", "Claude Code", "cmd.exe", "/k", claude] };
	}

	if (process.platform === "darwin") {
		const script = [
			cwd ? `cd ${shellQuote(cwd)}` : undefined,
			[`sh`, shellQuote(`${location.dataDirForClaude}/${HELPERS.runClaude}`), ...args.map(shellQuote)].join(" "),
		]
			.filter(Boolean)
			.join(" && ");

		return {
			command: "osascript",
			spawnArgs: ["-e", `tell application "Terminal" to do script ${JSON.stringify(script)}`, "-e", 'tell application "Terminal" to activate'],
		};
	}

	// Linux: Stream Deck does not ship here, but keep the path honest for devs.
	const script = [cwd ? `cd ${shellQuote(cwd)}` : undefined, ["claude", ...args.map(shellQuote)].join(" ")]
		.filter(Boolean)
		.join(" && ");

	return { command: "x-terminal-emulator", spawnArgs: ["-e", `sh -c ${shellQuote(script)}`] };
}
