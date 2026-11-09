import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import streamDeck from "@elgato/streamdeck";

import { DeckAction, animationPhase, type AnyAction } from "./base.js";
import { runtime } from "../runtime.js";
import { keyLabel } from "../bridge/summarize.js";
import { duration, tile } from "../ui/render.js";
import { runHeadless, type Runner } from "../claude/headless.js";
import { dataDir } from "../claude/history.js";
import { openWithSystem } from "../system/open.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type HeadlessSettings = {
	prompt?: string;
	label?: string;
	/** Working directory for the run; falls back to the plugin default. */
	cwd?: string;
	model?: string;
	permissionMode?: string;
	extraArgs?: string;
	runner?: Runner;
	distro?: string;
	timeoutSec?: number;
} & JsonObject;

type RunState = {
	startedAt: number;
	done?: { ok: boolean; text: string; durationMs: number; at: number; file?: string };
};

/** In-flight and recently finished runs, per action context. */
const runs = new Map<string, RunState>();

/**
 * How long a finished run waits on the key to be read.
 *
 * Long, because a five-minute task usually finishes while you look elsewhere,
 * and the result is the whole point of having run it.
 */
const RESULT_LINGER_MS = 30 * 60_000;

/**
 * Keeps a run's full answer where it can be read.
 * @returns The file, or `undefined` when it could not be written.
 */
async function saveResult(label: string, prompt: string, cwd: string, ok: boolean, text: string, durationMs: number): Promise<string | undefined> {
	const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
	const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
	const file = join(dataDir(), "runs", `${stamp}-${slug}.md`);
	const body = [
		`# ${label}`,
		"",
		`- Folder: \`${cwd}\``,
		`- ${ok ? "Finished" : "Failed"} after ${duration(durationMs)}`,
		`- Prompt: ${prompt}`,
		"",
		"---",
		"",
		text || (ok ? "(no output)" : "(no output — see the plugin log)"),
		"",
	].join("\n");

	try {
		await mkdir(join(dataDir(), "runs"), { recursive: true });
		await writeFile(file, body, "utf8");
		return file;
	} catch {
		return undefined;
	}
}

/** The folder a task runs in: its own, or the plugin-wide default. */
function folderOf(settings: HeadlessSettings): string | undefined {
	return settings.cwd?.trim() || runtime.settings.defaultCwd?.trim() || undefined;
}

function folderName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** What an unconfigured key runs; useful in any repository. */
const DEFAULT_TASK = "Review the current git diff and list anything risky in a few bullets.";

/**
 * Runs a one-shot Claude task with `claude -p`.
 *
 * This is deliberately separate from the live session: it spawns its own
 * Claude Code process, so it never disturbs whatever you have open.
 */
@action({ UUID: "io.github.claude-deck.plugin.headless" })
export class HeadlessAction extends DeckAction<HeadlessSettings> {
	protected override animates(key: AnyAction<HeadlessSettings>): boolean {
		const run = runs.get(key.id);
		return run !== undefined && run.done === undefined;
	}

	protected override async draw(key: AnyAction<HeadlessSettings>, settings: HeadlessSettings): Promise<void> {
		if (!key.isKey()) {
			return;
		}

		const label = settings.label || keyLabel(settings.prompt || DEFAULT_TASK, 26);
		const run = runs.get(key.id);

		if (run && !run.done) {
			await key.setState(1);
			await key.setImage(
				tile({
					family: "launch",
					tone: "working",
					edge: "travel",
					phase: animationPhase(),
					eyebrow: "Running",
					headline: label,
					subtitle: duration(Date.now() - run.startedAt),
				}),
			);
			return;
		}

		if (run?.done && Date.now() - run.done.at < RESULT_LINGER_MS) {
			await key.setState(0);
			await key.setImage(
				tile({
					family: "launch",
					tone: run.done.ok ? "working" : "error",
					eyebrow: run.done.ok ? `Done in ${duration(run.done.durationMs)}` : "Failed",
					headline: label,
					subtitle: run.done.file ? "press to read" : keyLabel(run.done.text, 30),
				}),
			);
			return;
		}

		runs.delete(key.id);
		await key.setState(0);
		await key.setImage(
			tile({
				family: "launch",
				tone: "accent",
				eyebrow: "Task",
				headline: label,
				subtitle: folderOf(settings) ? keyLabel(folderName(folderOf(settings)!), 24) : "Set a folder",
			}),
		);
	}

	override async onKeyDown(ev: KeyDownEvent<HeadlessSettings>): Promise<void> {
		const settings = ev.payload.settings;

		const previous = runs.get(ev.action.id);
		if (previous && previous.done === undefined) {
			// Already running; a second press should not start a parallel run.
			await this.refuse(ev.action, "Already running");
			return;
		}

		// A finished run is waiting to be read: this press opens it.
		if (previous?.done?.file && Date.now() - previous.done.at < RESULT_LINGER_MS) {
			runs.delete(ev.action.id);
			const error = openWithSystem(previous.done.file);
			await (error ? this.refuse(ev.action, "Could not open the result") : this.inform(ev.action, "Opened the result"));
			return;
		}

		// Without a folder a task runs wherever the plugin happens to be, which
		// for "review the diff" means no repository at all.
		const cwd = folderOf(settings);
		if (!cwd) {
			await this.refuse(ev.action, "Set a folder first");
			return;
		}

		runs.set(ev.action.id, { startedAt: Date.now() });
		this.repaint();

		// Run where the hooks were installed, rather than guessing per platform.
		const location = await runtime.location(settings.runner, settings.distro);

		const result = await runHeadless({
			prompt: settings.prompt?.trim() || DEFAULT_TASK,
			cwd,
			location,
			helpers: await runtime.helperContext(),
			model: settings.model || undefined,
			permissionMode: settings.permissionMode || undefined,
			extraArgs: settings.extraArgs,
			timeoutMs: Math.max(10, settings.timeoutSec ?? 300) * 1000,
		});

		const label = settings.label || keyLabel(settings.prompt || DEFAULT_TASK, 26);
		const file = await saveResult(label, settings.prompt?.trim() || DEFAULT_TASK, cwd, result.ok, result.text, result.durationMs);
		runs.set(ev.action.id, {
			startedAt: runs.get(ev.action.id)?.startedAt ?? Date.now(),
			done: { ok: result.ok, text: result.text || (result.ok ? "done" : "no output"), durationMs: result.durationMs, at: Date.now(), file },
		});

		streamDeck.logger.info(`headless run ${result.ok ? "ok" : "failed"} in ${result.durationMs}ms`);
		runtime.emit("notify", {
			title: result.ok ? "Task finished" : "Task failed",
			body: result.text.slice(0, 200),
		});

		await (result.ok ? ev.action.showOk() : ev.action.showAlert());
		this.repaint();
	}
}
