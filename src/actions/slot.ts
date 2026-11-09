import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, animationPhase, type AnyAction } from "./base.js";
import { runtime } from "../runtime.js";
import { duration, tile, type EdgeMotion, type TileTone, MOODS } from "../ui/render.js";
import type { SessionStatus } from "../bridge/types.js";

type SlotSettings = {
	/** Which session this key owns, counting from one. */
	index?: number;
	/** Pressing pins the session for the rest of the deck instead of approving. */
	press?: "pin" | "approve";
	/** Draw Clawd under the state word; off shows the tool and timer instead. */
	mascot?: boolean;
} & JsonObject;

const TONES: Record<SessionStatus, TileTone> = {
	idle: "idle",
	working: "working",
	waiting: "waiting",
	compacting: "compacting",
	error: "error",
	ended: "offline",
};

const WORDS: Record<SessionStatus, string> = {
	idle: "Idle",
	working: "Working",
	waiting: "Approve?",
	compacting: "Compacting",
	error: "Failed",
	ended: "Ended",
};

const EDGES: Record<SessionStatus, EdgeMotion> = {
	idle: "quiet",
	working: "travel",
	waiting: "pulse",
	compacting: "drift",
	error: "broken",
	ended: "quiet",
};

/** Keys only need frames while their border is actually moving. */
const MOVING: SessionStatus[] = ["working", "waiting", "compacting"];

/**
 * Gives one session a key of its own.
 *
 * A row of these turns the deck into a board of everything running: each key
 * keeps its project for the session's whole life, so you learn where to look
 * rather than reading labels every time.
 */
@action({ UUID: "io.github.claude-deck.plugin.slot" })
export class SlotAction extends DeckAction<SlotSettings> {
	protected override animates(_key: AnyAction<SlotSettings>, settings: SlotSettings): boolean {
		const session = runtime.store.ordered()[Math.max(1, Number(settings.index) || 1) - 1];
		return session !== undefined && MOVING.includes(session.status);
	}

	protected override async draw(key: AnyAction<SlotSettings>, settings: SlotSettings): Promise<void> {
		if (!key.isKey()) {
			return;
		}

		const index = Math.max(1, Number(settings.index) || 1) - 1;
		const session = runtime.store.ordered()[index];

		if (!session) {
			await key.setImage(
				settings.mascot === false
					? tile({ tone: "offline", eyebrow: `Slot ${index + 1}`, subtitle: "No session" })
					: tile({ tone: "offline", eyebrow: `Slot ${index + 1}`, headline: "Empty", mascot: "offline" }),
			);
			return;
		}

		const pinned = runtime.store.pinnedSessionId === session.sessionId;
		const elapsed = session.turnStartedAt ? Date.now() - session.turnStartedAt : 0;

		await key.setImage(
			tile({
				tone: TONES[session.status],
				edge: EDGES[session.status],
				phase: animationPhase(),
				eyebrow: pinned ? `📌 ${session.project}` : session.project,
				headline: WORDS[session.status],
				headlineTone: "state",
				subtitle:
					session.status === "waiting" && session.pending
						? session.pending.summary
						: session.status === "working"
							? [session.currentTool, elapsed ? duration(elapsed) : undefined].filter(Boolean).join("  ")
							: undefined,
				badge: session.queue.length || undefined,
				mascot: settings.mascot === false ? undefined : MOODS[session.status],
			}),
		);
	}

	override async onKeyDown(ev: KeyDownEvent<SlotSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const index = Math.max(1, Number(settings.index) || 1) - 1;
		const session = runtime.store.ordered()[index];

		if (!session) {
			await this.refuse(ev.action, "No session in this slot");
			return;
		}

		// Answering the request this key is already showing beats hunting for it.
		if (settings.press === "approve" && session.pending) {
			runtime.bridge.decide(session.pending.toolUseId, "allow");
			await ev.action.showOk();
			this.repaint();
			return;
		}

		runtime.store.pinnedSessionId = runtime.store.pinnedSessionId === session.sessionId ? undefined : session.sessionId;
		await ev.action.showOk();
		this.repaint();
	}
}
