import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, type AnyAction, type SessionScoped } from "./base.js";
import { runtime } from "../runtime.js";
import { duration, tile, type TileTone } from "../ui/render.js";
import type { SessionState, SessionStatus } from "../bridge/types.js";

type StatusSettings = SessionScoped & {
	/** Show the project folder instead of the status word. */
	showProject?: boolean;
	/** Show the tool Claude is currently running. */
	showTool?: boolean;
} & JsonObject;

const TONES: Record<SessionStatus, TileTone> = {
	idle: "idle",
	working: "working",
	waiting: "waiting",
	compacting: "compacting",
	error: "error",
	ended: "offline",
};

const GLYPHS: Record<SessionStatus, string> = {
	idle: "●",
	working: "▶",
	waiting: "?",
	compacting: "⟳",
	error: "!",
	ended: "○",
};

const WORDS: Record<SessionStatus, string> = {
	idle: "Idle",
	working: "Working",
	waiting: "Needs you",
	compacting: "Compacting",
	error: "Failed",
	ended: "Ended",
};

/**
 * Live state of a Claude Code session.
 *
 * Pressing it jumps to whichever session needs attention, which makes a single
 * status key usable even with several projects open.
 */
@action({ UUID: "io.github.claude-deck.plugin.status" })
export class StatusAction extends DeckAction<StatusSettings> {
	protected override async draw(key: AnyAction<StatusSettings>, settings: StatusSettings): Promise<void> {
		if (!key.isKey()) {
			return;
		}

		if (!runtime.bridge.listening) {
			await key.setImage(
				tile({ tone: "error", glyph: "!", title: "Bridge down", subtitle: runtime.bridge.lastError ? "Check port" : "Starting…" }),
			);
			return;
		}

		const session = runtime.store.resolve(settings.session);
		if (!session) {
			await key.setImage(
				tile({
					tone: "offline",
					glyph: "○",
					title: "No session",
					subtitle: runtime.settings.hooksInstalled ? "Start Claude Code" : "Not connected",
				}),
			);
			return;
		}

		await key.setImage(tile(this.#describe(session, settings)));
	}

	/** Chooses glyph, title and subtitle for the session's current state. */
	#describe(session: SessionState, settings: StatusSettings) {
		const elapsed = session.turnStartedAt ? Date.now() - session.turnStartedAt : 0;

		const subtitle =
			session.status === "waiting" && session.pending
				? session.pending.summary
				: session.status === "error"
					? (session.lastError ?? "")
					: session.status === "working"
						? [settings.showTool !== false ? session.currentTool : undefined, elapsed ? duration(elapsed) : undefined]
								.filter(Boolean)
								.join(" · ")
						: session.project;

		return {
			tone: TONES[session.status],
			glyph: GLYPHS[session.status],
			title: settings.showProject ? session.project : WORDS[session.status],
			subtitle,
			eyebrow: settings.showProject ? WORDS[session.status] : undefined,
			badge: session.queue.length > 0 ? session.queue.length : undefined,
			progress:
				session.status === "waiting" && session.pending
					? Math.max(0, (session.pending.expiresAt - Date.now()) / (session.pending.expiresAt - session.pending.receivedAt))
					: undefined,
		} as const;
	}

	override async onKeyDown(ev: KeyDownEvent<StatusSettings>): Promise<void> {
		// Pin the session that currently wants something, so other keys follow it.
		const attention = runtime.store.list().find((s) => s.status === "waiting" || s.status === "error");
		runtime.store.pinnedSessionId = attention?.sessionId;

		await ev.action.showOk();
		this.repaint();
	}
}
