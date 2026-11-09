import {
	action,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type KeyDownEvent,
	type TouchTapEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, type AnyAction, type SessionScoped } from "./base.js";
import type { ChartData, TileTone } from "../ui/render.js";
import { runtime } from "../runtime.js";
import { projectFull } from "../claude/history.js";
import { compactNumber, duration, strip, tile } from "../ui/render.js";
import type { SessionState } from "../bridge/types.js";

type Metric = "turn" | "context" | "tokens" | "tools" | "busy" | "plan5h" | "planWeek" | "today" | "week";

type UsageSettings = SessionScoped & {
	metric?: Metric;
} & JsonObject;

const ORDER: Metric[] = ["turn", "context", "plan5h", "planWeek", "today", "week", "tokens", "tools", "busy"];

type View = {
	title: string;
	value: string;
	subtitle: string;
	tone: TileTone;
	progress: number | undefined;
	chart?: ChartData;
};

/** Points across a plan window's chart. */
const TREND_POINTS = 24;

/**
 * Resamples irregular readings onto even steps from the window's start to now.
 *
 * Each step holds the last reading before it; steps before the first reading
 * take that first reading, because the plugin simply was not listening then.
 */
export function resample(points: { at: number; used: number }[], start: number, now: number, count = TREND_POINTS): number[] {
	if (points.length === 0) {
		return [];
	}
	const step = (now - start) / Math.max(1, count - 1);
	let cursor = 0;
	return Array.from({ length: count }, (_, index) => {
		const at = start + index * step;
		while (cursor + 1 < points.length && points[cursor + 1].at <= at) {
			cursor += 1;
		}
		return points[cursor].used;
	});
}

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
function planView(metric: "plan5h" | "planWeek"): View {
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

	const now = Date.now();
	const used = Math.max(0, Math.min(100, window.usedPercent));
	const points = runtime.planTrend.within(metric === "plan5h" ? "five" : "week", window.resetsAt);
	const span = metric === "plan5h" ? 5 * 3_600_000 : 7 * 24 * 3_600_000;

	// At the recent pace, does this run out before it resets? That is the
	// question the number alone cannot answer.
	const fullAt = projectFull(points, now);
	const runsOut = fullAt !== undefined && fullAt < window.resetsAt && used < 100;

	return {
		title,
		value: `${Math.round(used)}%`,
		subtitle: runsOut ? `full in ${resetIn(fullAt - now)}` : `resets ${resetIn(window.resetsAt - now)}`,
		tone: used >= 90 ? "error" : used >= 70 || runsOut ? "waiting" : "working",
		progress: used / 100,
		chart: points.length >= 2 ? { kind: "line", max: 100, series: resample(points, window.resetsAt - span, now) } : undefined,
	};
}

/** Token history: today by hour, or the week by day. */
function historyView(metric: "today" | "week"): View {
	runtime.refreshHistory();
	const history = runtime.history;
	const title = metric === "today" ? "Today" : "7 days";

	if (history.empty) {
		return { title, value: "—", subtitle: "No transcripts yet", tone: "offline", progress: undefined };
	}

	const days = history.daily(7);
	const today = days[days.length - 1];
	if (metric === "today") {
		return {
			title,
			value: compactNumber(today),
			subtitle: "tokens · last 12 h",
			tone: "accent",
			progress: undefined,
			chart: { kind: "bars", series: history.hourly(12) },
		};
	}

	return {
		title,
		value: compactNumber(days.reduce((sum, day) => sum + day, 0)),
		subtitle: `today ${compactNumber(today)}`,
		tone: "accent",
		progress: undefined,
		chart: { kind: "bars", series: days },
	};
}

/**
 * Steps away from the configured metric, per action context.
 *
 * A key falls back to its own metric after a while, so a bump never leaves a
 * "Context" key showing something else for good; a dial was turned on purpose
 * and stays where it was put.
 */
const cursors = new Map<string, { offset: number; at: number }>();

/** How long a key shows a stepped-to metric before returning to its own. */
const STEP_LINGER_MS = 10_000;

/** Touch-strip layout each dial currently has, so it is only switched when it changes. */
const layouts = new Map<string, string>();

const STOCK_LAYOUT = "$B1";
const CHART_LAYOUT = "layouts/chart.json";

/**
 * Turn timer, token counters and context pressure.
 *
 * Token numbers are read from the session transcript when the plugin can reach
 * it; otherwise the key falls back to what the hooks alone can tell it.
 */
@action({ UUID: "com.andondeck.plugin.usage" })
export class UsageAction extends DeckAction<UsageSettings> {
	protected override async draw(unit: AnyAction<UsageSettings>, settings: UsageSettings): Promise<void> {
		const session = runtime.store.resolve(settings.session);
		const metric = this.#metric(unit, settings);
		const view = this.#view(session, metric);

		if (unit.isDial()) {
			const layout = view.chart ? CHART_LAYOUT : STOCK_LAYOUT;
			if (layouts.get(unit.id) !== layout) {
				layouts.set(unit.id, layout);
				await unit.setFeedbackLayout(layout);
			}

			if (view.chart) {
				await unit.setFeedback({
					canvas: strip({ title: view.title, value: view.value, subtitle: view.subtitle, tone: view.tone, chart: view.chart }),
				});
				return;
			}

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

		// On a key, a plan limit keeps its projection line: "full in 1h 20m" is
		// worth more than the curve behind it. Dials have room for both.
		const chart = metric === "plan5h" || metric === "planWeek" ? undefined : view.chart;
		await unit.setImage(
			tile({
				family: "meter",
				tone: view.tone,
				eyebrow: view.title,
				headline: view.value,
				subtitle: view.subtitle,
				// A chart already shows the level; a bar under it would say it twice.
				progress: chart ? undefined : view.progress,
				chart,
			}),
		);
	}

	#metric(unit: AnyAction<UsageSettings>, settings: UsageSettings): Metric {
		const own = settings.metric && ORDER.includes(settings.metric) ? settings.metric : "turn";
		const stepped = cursors.get(unit.id);
		if (!stepped) {
			return own;
		}
		if (unit.isKey() && Date.now() - stepped.at > STEP_LINGER_MS) {
			cursors.delete(unit.id);
			return own;
		}

		const index = ORDER.indexOf(own) + stepped.offset;
		return ORDER[((index % ORDER.length) + ORDER.length) % ORDER.length];
	}

	/** Turns a metric into something that fits on a key or a dial readout. */
	#view(session: SessionState | undefined, metric: Metric): View {
		// Plan limits and history belong to the account, not a session, so they show without one.
		if (metric === "plan5h" || metric === "planWeek") {
			return planView(metric);
		}
		if (metric === "today" || metric === "week") {
			return historyView(metric);
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

	protected override onDisappear(ev: WillDisappearEvent<UsageSettings>): void {
		// A dial that comes back starts on the manifest's layout again.
		layouts.delete(ev.action.id);
		cursors.delete(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<UsageSettings>): Promise<void> {
		this.#step(ev.action.id, 1, false);
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

	#step(context: string, by: number, dial = true): void {
		const current = cursors.get(context);
		// A key that already fell back starts again from its own metric.
		const offset = current && (dial || Date.now() - current.at <= STEP_LINGER_MS) ? current.offset : 0;
		cursors.set(context, { offset: offset + by, at: Date.now() });
		this.repaint();
	}
}
