import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import streamDeck from "@elgato/streamdeck";

import { DeckAction, animationPhase, type AnyAction } from "./base.js";
import { runtime } from "../runtime.js";
import { keyLabel } from "../bridge/summarize.js";
import { duration, tile } from "../ui/render.js";
import { runHeadless, type Runner } from "../claude/headless.js";

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
	done?: { ok: boolean; text: string; durationMs: number; at: number };
};

/** In-flight and recently finished runs, per action context. */
const runs = new Map<string, RunState>();

/** How long a finished run stays on the key before it resets. */
const RESULT_LINGER_MS = 20_000;

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
					subtitle: keyLabel(run.done.text, 30),
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
				subtitle: settings.cwd ? keyLabel(settings.cwd, 24) : "Default folder",
			}),
		);
	}

	override async onKeyDown(ev: KeyDownEvent<HeadlessSettings>): Promise<void> {
		const settings = ev.payload.settings;

		if (runs.get(ev.action.id)?.done === undefined && runs.has(ev.action.id)) {
			// Already running; a second press should not start a parallel run.
			await this.refuse(ev.action, "Already running");
			return;
		}

		runs.set(ev.action.id, { startedAt: Date.now() });
		this.repaint();

		// Run where the hooks were installed, rather than guessing per platform.
		const location = await runtime.location(settings.runner, settings.distro);

		const result = await runHeadless({
			prompt: settings.prompt?.trim() || DEFAULT_TASK,
			cwd: settings.cwd || runtime.settings.defaultCwd || undefined,
			location,
			helpers: await runtime.helperContext(),
			model: settings.model || undefined,
			permissionMode: settings.permissionMode || undefined,
			extraArgs: settings.extraArgs,
			timeoutMs: Math.max(10, settings.timeoutSec ?? 300) * 1000,
		});

		runs.set(ev.action.id, {
			startedAt: runs.get(ev.action.id)?.startedAt ?? Date.now(),
			done: { ok: result.ok, text: result.text || (result.ok ? "done" : "no output"), durationMs: result.durationMs, at: Date.now() },
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
