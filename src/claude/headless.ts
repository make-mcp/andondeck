import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type { ClaudeLocation } from "./env.js";
import { HELPERS, helperPath, writeHelpers } from "./helpers.js";

/** How Claude Code is reached from the machine Stream Deck runs on. */
export type Runner = "auto" | "native" | "wsl";

export type HeadlessRequest = {
	prompt: string;
	cwd?: string;
	/** Where Claude Code lives; also supplies the generated runner script. */
	location: ClaudeLocation;
	model?: string;
	permissionMode?: string;
	/** Extra CLI arguments, split on whitespace; e.g. `--allowedTools Read,Grep`. */
	extraArgs?: string;
	timeoutMs: number;
	/** Bridge details, used only when the helper scripts have to be written first. */
	helpers?: { baseUrl: string; token: string };
};

export type HeadlessResult = {
	ok: boolean;
	/** Claude's final message, or the error text when it failed. */
	text: string;
	durationMs: number;
	costUsd?: number;
	sessionId?: string;
};

function splitArgs(value?: string): string[] {
	return value ? value.trim().split(/\s+/).filter(Boolean) : [];
}

/** Makes sure the generated runner script exists before it is invoked. */
async function ensureRunner(request: HeadlessRequest): Promise<boolean> {
	const script = join(request.location.dataDir, HELPERS.runClaude);

	try {
		await access(script);
		return true;
	} catch {
		// Not connected yet, or the helpers were deleted.
	}

	try {
		await writeHelpers({
			location: request.location,
			baseUrl: request.helpers?.baseUrl ?? "http://127.0.0.1",
			token: request.helpers?.token ?? "",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Runs a one-shot Claude Code task with `claude -p`.
 *
 * Two things keep this working across installs: the prompt travels over stdin
 * rather than argv, and the executable is located by a generated script rather
 * than relying on `PATH` — hooks and `wsl.exe` both spawn without a login
 * shell, where nvm, fnm and volta installs are invisible.
 * @param request What to run and where.
 * @returns The outcome, including Claude's final message.
 */
export async function runHeadless(request: HeadlessRequest): Promise<HeadlessResult> {
	const started = Date.now();
	const claudeArgs = ["-p", "--output-format", "json"];

	if (request.model) {
		claudeArgs.push("--model", request.model);
	}
	if (request.permissionMode) {
		claudeArgs.push("--permission-mode", request.permissionMode);
	}
	claudeArgs.push(...splitArgs(request.extraArgs));

	const hasRunner = await ensureRunner(request);
	const { commands, args, cwd } = plan(request, claudeArgs, hasRunner);

	return attempt(0);

	/** Tries one spelling of the executable, falling forward on ENOENT. */
	function attempt(index: number): Promise<HeadlessResult> {
		const command = commands[index];

		return new Promise<HeadlessResult>((resolve) => {
			const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

			let stdout = "";
			let stderr = "";
			let settled = false;

			const finish = (result: HeadlessResult): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};

			const timer = setTimeout(() => {
				child.kill();
				finish({
					ok: false,
					text: `Timed out after ${Math.round(request.timeoutMs / 1000)}s`,
					durationMs: Date.now() - started,
				});
			}, request.timeoutMs);
			timer.unref?.();

			child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
			child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

			child.on("error", (error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT" && index + 1 < commands.length) {
					settled = true;
					clearTimeout(timer);
					resolve(attempt(index + 1));
					return;
				}

				finish({
					ok: false,
					text:
						(error as NodeJS.ErrnoException).code === "ENOENT"
							? `Could not run \`${command}\`. Check the runner in this action's settings.`
							: error.message,
					durationMs: Date.now() - started,
				});
			});

			child.on("close", (code) => {
				const durationMs = Date.now() - started;
				const parsed = parseResult(stdout);

				if (parsed) {
					finish({
						ok: code === 0 && !parsed.isError,
						text: parsed.text,
						durationMs,
						costUsd: parsed.costUsd,
						sessionId: parsed.sessionId,
					});
					return;
				}

				finish({
					ok: false,
					text: (stderr.trim() || stdout.trim() || `claude exited with code ${code}`).slice(0, 500),
					durationMs,
				});
			});

			child.stdin.end(request.prompt, "utf8");
		});
	}
}

/**
 * Decides which executable to spawn and with what arguments.
 *
 * Only plain arguments cross into `wsl.exe` — never shell source, whose
 * quoting it mangles badly enough to blank out `$HOME`.
 * @param request The request.
 * @param claudeArgs Arguments for `claude` itself.
 * @param hasRunner Whether the generated runner script is available.
 * @returns The spawn plan.
 */
function plan(
	request: HeadlessRequest,
	claudeArgs: string[],
	hasRunner: boolean,
): { commands: string[]; args: string[]; cwd?: string } {
	if (request.location.kind === "wsl") {
		const prefix = [
			...(request.location.distro ? ["-d", request.location.distro] : []),
			...(request.cwd ? ["--cd", request.cwd] : []),
			"--",
		];

		return {
			commands: ["wsl.exe"],
			args: hasRunner
				? [...prefix, "sh", helperPath(request.location, "runClaude"), ...claudeArgs]
				: [...prefix, "claude", ...claudeArgs],
		};
	}

	if (process.platform === "win32") {
		// npm installs a .cmd shim; the native installer provides an .exe.
		return { commands: ["claude.cmd", "claude.exe", "claude"], args: claudeArgs, cwd: request.cwd };
	}

	return hasRunner
		? {
				commands: ["/bin/sh"],
				args: [join(request.location.dataDir, HELPERS.runClaude), ...claudeArgs],
				cwd: request.cwd,
			}
		: { commands: ["claude"], args: claudeArgs, cwd: request.cwd };
}

type ParsedResult = { text: string; isError: boolean; costUsd?: number; sessionId?: string };

/** Pulls the result envelope out of `--output-format json` output. */
function parseResult(stdout: string): ParsedResult | undefined {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return undefined;
	}

	// Some runners prepend shell noise; take the last JSON object on its own line.
	for (const line of trimmed.split("\n").reverse()) {
		const candidate = line.trim();
		if (!candidate.startsWith("{")) {
			continue;
		}

		try {
			const entry = JSON.parse(candidate) as Record<string, unknown>;
			const text = typeof entry.result === "string" ? entry.result : typeof entry.error === "string" ? entry.error : "";
			if (!text && entry.type !== "result") {
				continue;
			}

			return {
				text,
				isError: entry.is_error === true || entry.subtype === "error",
				costUsd: typeof entry.total_cost_usd === "number" ? entry.total_cost_usd : undefined,
				sessionId: typeof entry.session_id === "string" ? entry.session_id : undefined,
			};
		} catch {
			continue;
		}
	}

	return undefined;
}
