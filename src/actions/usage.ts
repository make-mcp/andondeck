import {
	action,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type KeyDownEvent,
	type TouchTapEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, type AnyAction, type SessionScoped } from "./base.js";
import type { TileTone } from "../ui/render.js";
import { runtime } from "../runtime.js";
import { compactNumber, duration, tile } from "../ui/render.js";
import type { SessionState } from "../bridge/types.js";

type Metric = "turn" | "context" | "tokens" | "tools" | "busy" | "plan5h" | "planWeek";

type UsageSettings = SessionScoped & {
	metric?: Metric;
} & JsonObject;

const ORDER: Metric[] = ["turn", "context", "plan5h", "planWeek", "tokens", "tools", "busy"];

/**
 * Context window sizes the deck draws the pressure bar against.
 *
 * Only used to turn a token count into a bar; the number itself is always the
 * measured one, never an estimate.
 */
const CONTEXT_WINDOWS: { match: RegExp; size: number }[] = [
	{ match: /\[1m\]|-1m\b/i, size: 1_000_000 },
	{ match: /haiku/i, size: 200_000 },
	{ match: /./, size: 200_000 },
];

function contextWindow(model?: string): number {
	return CONTEXT_WINDOWS.find((entry) => entry.match.test(model ?? ""))?.size ?? 200_000;
}

/** A reset countdown short enough for a key: `2d 4h`, `3h 12m`, `12m`. */
export function resetIn(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	if (days > 0) {
		return `${days}d ${hours}h`;
	}
	return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/**
 * A plan-limit window: how much is used and when it resets.
 *
 * Claude Code only reports these to its status line, and only for claude.ai
 * subscribers; the key says which of those is missing rather than showing 0%.
 */
function planView(metric: "plan5h" | "planWeek"): {
	title: string;
	value: string;
	subtitle: string;
	tone: TileTone;
	progress: number | undefined;
} {
	const title = metric === "plan5h" ? "5h limit" : "Week limit";
	const limits = runtime.bridge.planLimits;
	const window = metric === "plan5h" ? limits?.fiveHour : limits?.sevenDay;

	if (!window || window.resetsAt <= Date.now()) {
		return {
			title,
			value: "—",
			subtitle: !runtime.settings.planLimits ? "Turned off" : limits ? "Window reset" : "Waiting for Claude",
			tone: "offline",
			progress: undefined,
		};
	}

	const used = Math.max(0, Math.min(100, window.usedPercent));
	return {
		title,
		value: `${Math.round(used)}%`,
		subtitle: `resets ${resetIn(window.resetsAt - Date.now())}`,
		tone: used >= 90 ? "error" : used >= 70 ? "waiting" : "working",
		progress: used / 100,
	};
}

/** Metric currently shown, per action context, when the dial steps through them. */
const cursors = new Map<string, number>();

/**
 * Turn timer, token counters and context pressure.
 *
 * Token numbers are read from the session transcript when the plugin can reach
 * it; otherwise the key falls back to what the hooks alone can tell it.
 */
@action({ UUID: "io.github.claude-deck.plugin.usage" })
export class UsageAction extends DeckAction<UsageSettings> {
	protected override async draw(unit: AnyAction<UsageSettings>, settings: UsageSettings): Promise<void> {
		const session = runtime.store.resolve(settings.session);
		const metric = this.#metric(unit.id, settings);
		const view = this.#view(session, metric);

		if (unit.isDial()) {
			await unit.setFeedback({
				title: view.title,
				value: view.value,
				indicator: { value: Math.round((view.progress ?? 0) * 100) },
			});
			return;
		}

		if (!unit.isKey()) {
			return;
		}

		await unit.setImage(
			tile({
				tone: view.tone,
				eyebrow: view.title,
				headline: view.value,
				subtitle: view.subtitle,
				progress: view.progress,
			}),
		);
	}

	#metric(context: string, settings: UsageSettings): Metric {
		if (settings.metric && settings.metric !== "turn") {
			return settings.metric;
		}

		const stepped = cursors.get(context);
		return stepped === undefined ? (settings.metric ?? "turn") : ORDER[((stepped % ORDER.length) + ORDER.length) % ORDER.length];
	}

	/** Turns a metric into something that fits on a key or a dial readout. */
	#view(session: SessionState | undefined, metric: Metric): {
		title: string;
		value: string;
		subtitle: string;
		tone: TileTone;
		progress: number | undefined;
	} {
		// Plan limits belong to the account, not a session, so they show without one.
		if (metric === "plan5h" || metric === "planWeek") {
			return planView(metric);
		}

		if (!session) {
			return { title: "Claude", value: "—", subtitle: "No session", tone: "offline", progress: undefined };
		}

		const { usage } = session;

		switch (metric) {
			case "context": {
				// With a managed auto-compact threshold, "full" means "about to
				// compact", which is the number worth watching.
				const compactAt = runtime.autoCompactWindow();
				const window = Math.min(
					usage.contextWindow ?? contextWindow(session.model),
					typeof compactAt === "number" ? compactAt : Infinity,
				);
				const ratio = usage.contextTokens / window;
				return {
					title: typeof compactAt === "number" ? "To compact" : "Context",
					value: usage.contextTokens ? `${Math.round(ratio * 100)}%` : "—",
					subtitle: usage.contextTokens ? `${compactNumber(usage.contextTokens)} / ${compactNumber(window)}` : "unknown",
					tone: ratio > 0.85 ? "error" : ratio > 0.6 ? "working" : "idle",
					progress: usage.contextTokens ? ratio : undefined,
				};
			}

			case "tokens": {
				const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens;
				return {
					title: "Tokens",
					value: compactNumber(total),
					subtitle: `${compactNumber(usage.outputTokens)} out`,
					tone: "accent",
					progress: undefined,
				};
			}

			case "tools": {
				return {
					title: "Tools",
					value: String(usage.toolCalls),
					subtitle: `${usage.turns} turns`,
					tone: "accent",
					progress: undefined,
				};
			}

			case "busy": {
				return {
					title: "Busy",
					value: duration(usage.busyMs),
					subtitle: `${usage.turns} turns`,
					tone: "accent",
					progress: undefined,
				};
			}

			default: {
				const elapsed = session.turnStartedAt ? Date.now() - session.turnStartedAt : 0;
				return {
					title: session.status === "working" ? "This turn" : "Last turn",
					value: elapsed ? duration(elapsed) : duration(usage.busyMs / Math.max(1, usage.turns)),
					subtitle: session.currentTool ?? session.status,
					tone: session.status === "working" ? "working" : "idle",
					progress: undefined,
				};
			}
		}
	}

	override async onKeyDown(ev: KeyDownEvent<UsageSettings>): Promise<void> {
		this.#step(ev.action.id, 1);
		await ev.action.showOk();
	}

	override async onDialRotate(ev: DialRotateEvent<UsageSettings>): Promise<void> {
		this.#step(ev.action.id, ev.payload.ticks);
		await this.draw(ev.action as DialAction<UsageSettings>, ev.payload.settings);
	}

	override async onDialDown(ev: DialDownEvent<UsageSettings>): Promise<void> {
		this.#step(ev.action.id, 1);
		await this.draw(ev.action as DialAction<UsageSettings>, ev.payload.settings);
	}

	override async onTouchTap(ev: TouchTapEvent<UsageSettings>): Promise<void> {
		this.#step(ev.action.id, 1);
		await this.draw(ev.action as DialAction<UsageSettings>, ev.payload.settings);
	}

	#step(context: string, by: number): void {
		cursors.set(context, (cursors.get(context) ?? 0) + by);
		this.repaint();
	}
}
