import {
	action,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type KeyDownEvent,
	type TouchTapEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, type AnyAction } from "./base.js";
import { runtime } from "../runtime.js";
import { tile } from "../ui/render.js";

type SessionSettings = {
	/** Key mode: pin a specific session, or step through the open ones. */
	mode?: "cycle" | "pin";
	/** Session bound to this key when `mode` is `pin`. */
	target?: string;
} & JsonObject;

/** Dial cursor per action context. */
const cursors = new Map<string, number>();

/**
 * Chooses which Claude Code session the rest of the deck follows.
 *
 * Without a pin every other action tracks the most recently active session,
 * preferring one that is waiting on the user.
 */
@action({ UUID: "io.github.claude-deck.plugin.session" })
export class SessionAction extends DeckAction<SessionSettings> {
	protected override async draw(unit: AnyAction<SessionSettings>, settings: SessionSettings): Promise<void> {
		const sessions = runtime.store.list();
		const pinnedId = runtime.store.pinnedSessionId;

		if (unit.isDial()) {
			const index = sessions.length ? this.#cursor(unit.id, sessions.length) : 0;
			const session = sessions[index];

			await unit.setFeedback({
				title: sessions.length ? `Session ${index + 1}/${sessions.length}` : "No sessions",
				value: session ? `${pinnedId === session.sessionId ? "📌 " : ""}${session.project}` : "—",
				icon: tile({ tone: session ? "accent" : "offline", glyph: String(sessions.length) }),
			});
			return;
		}

		if (!unit.isKey()) {
			return;
		}

		const bound = settings.mode === "pin" && settings.target ? runtime.store.resolve(settings.target) : undefined;
		const shown = bound ?? runtime.store.resolve();

		await unit.setImage(
			tile({
				tone: shown ? (pinnedId && pinnedId === shown.sessionId ? "accent" : "idle") : "offline",
				eyebrow: settings.mode === "pin" ? "pin" : "session",
				glyph: pinnedId && shown && pinnedId === shown.sessionId ? "📌" : "⇄",
				title: shown?.project ?? "No session",
				subtitle: shown ? `${sessions.length} open` : "Start Claude Code",
				badge: shown?.queue.length || undefined,
			}),
		);
	}

	#cursor(context: string, length: number): number {
		const raw = cursors.get(context) ?? 0;
		const clamped = ((raw % length) + length) % length;
		cursors.set(context, clamped);
		return clamped;
	}

	override async onKeyDown(ev: KeyDownEvent<SessionSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const sessions = runtime.store.list();

		if (sessions.length === 0) {
			await this.refuse(ev.action, "No Claude session yet");
			return;
		}

		if (settings.mode === "pin" && settings.target) {
			const target = runtime.store.resolve(settings.target);
			runtime.store.pinnedSessionId = target && target.sessionId !== runtime.store.pinnedSessionId ? target.sessionId : undefined;
		} else {
			const current = runtime.store.pinnedSessionId;
			const index = current ? sessions.findIndex((s) => s.sessionId === current) : -1;
			const next = sessions[(index + 1) % sessions.length];
			runtime.store.pinnedSessionId = index === sessions.length - 1 ? undefined : next.sessionId;
		}

		await ev.action.showOk();
		this.repaint();
	}

	override async onDialRotate(ev: DialRotateEvent<SessionSettings>): Promise<void> {
		if (runtime.store.list().length === 0) {
			return;
		}

		cursors.set(ev.action.id, (cursors.get(ev.action.id) ?? 0) + ev.payload.ticks);
		await this.draw(ev.action as DialAction<SessionSettings>, ev.payload.settings);
	}

	override async onDialDown(ev: DialDownEvent<SessionSettings>): Promise<void> {
		this.#pinAtCursor(ev.action.id);
	}

	override async onTouchTap(ev: TouchTapEvent<SessionSettings>): Promise<void> {
		this.#pinAtCursor(ev.action.id);
	}

	/** Pins the session under the dial cursor, or unpins it when it is already pinned. */
	#pinAtCursor(context: string): void {
		const sessions = runtime.store.list();
		if (sessions.length === 0) {
			return;
		}

		const session = sessions[this.#cursor(context, sessions.length)];
		runtime.store.pinnedSessionId = runtime.store.pinnedSessionId === session.sessionId ? undefined : session.sessionId;
		this.repaint();
	}
}
