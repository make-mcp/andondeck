import { spawn } from "node:child_process";

/** How Claude Code is reached from the machine Stream Deck runs on. */
export type Runner = "auto" | "native" | "wsl";

export type HeadlessRequest = {
	prompt: string;
	cwd?: string;
	runner: Runner;
	distro?: string;
	model?: string;
	permissionMode?: string;
	/** Extra CLI arguments, split on whitespace; e.g. `--allowedTools Read,Grep`. */
	extraArgs?: string;
	timeoutMs: number;
};

export type HeadlessResult = {
	ok: boolean;
	/** Claude's final message, or the error text when it failed. */
	text: string;
	durationMs: number;
	costUsd?: number;
	sessionId?: string;
};

/** Picks the runner when the user left it on "auto". */
export function resolveRunner(runner: Runner): "native" | "wsl" {
	if (runner !== "auto") {
		return runner;
	}

	// On Windows, Claude Code most commonly lives inside WSL.
	return process.platform === "win32" ? "wsl" : "native";
}

function splitArgs(value?: string): string[] {
	return value ? value.trim().split(/\s+/).filter(Boolean) : [];
}

/**
 * Runs a one-shot Claude Code task with `claude -p`.
 *
 * The prompt travels over stdin rather than argv, which keeps quoting out of
 * the picture entirely — important when the command has to cross into WSL.
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

	const mode = resolveRunner(request.runner);
	let command: string;
	let args: string[];
	let cwd: string | undefined;

	if (mode === "wsl") {
		const inner = ["claude", ...claudeArgs].join(" ");
		args = [
			...(request.distro ? ["-d", request.distro] : []),
			...(request.cwd ? ["--cd", request.cwd] : []),
			"--",
			"bash",
			"-lc",
			inner,
		];
		command = "wsl.exe";
	} else {
		command = process.platform === "win32" ? "claude.cmd" : "claude";
		args = claudeArgs;
		cwd = request.cwd;
	}

	return new Promise<HeadlessResult>((resolve) => {
		const child = spawn(command, args, {
			cwd,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});

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
			finish({ ok: false, text: `Timed out after ${Math.round(request.timeoutMs / 1000)}s`, durationMs: Date.now() - started });
		}, request.timeoutMs);
		timer.unref?.();

		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

		child.on("error", (error) => {
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
				finish({ ok: code === 0 && !parsed.isError, text: parsed.text, durationMs, costUsd: parsed.costUsd, sessionId: parsed.sessionId });
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
