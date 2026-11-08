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

type Metric = "turn" | "context" | "tokens" | "tools" | "busy";

type UsageSettings = SessionScoped & {
	metric?: Metric;
} & JsonObject;

const ORDER: Metric[] = ["turn", "context", "tokens", "tools", "busy"];

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
		if (!session) {
			return { title: "Claude", value: "—", subtitle: "No session", tone: "offline", progress: undefined };
		}

		const { usage } = session;

		switch (metric) {
			case "context": {
				const window = contextWindow(session.model);
				const ratio = usage.contextTokens / window;
				return {
					title: "Context",
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
