import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, animationPhase, type AnyAction, type SessionScoped } from "./base.js";
import { runtime } from "../runtime.js";
import { duration, tile, type EdgeMotion, type TileTone } from "../ui/render.js";
import type { SessionState, SessionStatus } from "../bridge/types.js";

type StatusSettings = SessionScoped & {
	/** Show the project folder instead of the status word. */
	showProject?: boolean;
	/** Show the tool Claude is currently running. */
	showTool?: boolean;
	/** Show the session's permission mode across the top of the key. */
	showPermissionMode?: boolean;
} & JsonObject;

const TONES: Record<SessionStatus, TileTone> = {
	idle: "idle",
	working: "working",
	waiting: "waiting",
	compacting: "compacting",
	error: "error",
	ended: "offline",
};

/** How the key's border behaves in each state. */
const EDGES: Record<SessionStatus, EdgeMotion> = {
	idle: "quiet",
	working: "travel",
	waiting: "pulse",
	compacting: "drift",
	error: "broken",
	ended: "quiet",
};

/** Short labels for permission modes; `default` is the uninteresting one. */
const MODES: Record<string, string | undefined> = {
	default: undefined,
	plan: "plan mode",
	acceptEdits: "auto-edit",
	auto: "auto",
	dontAsk: "don't ask",
	bypassPermissions: "bypass",
};

const WORDS: Record<SessionStatus, string> = {
	idle: "Idle",
	working: "Working",
	waiting: "Needs you",
	compacting: "Compacting",
	error: "Failed",
	ended: "Ended",
};

/** Keys only need frames while their border is actually moving. */
const MOVING: SessionStatus[] = ["working", "waiting", "compacting"];

/**
 * Live state of a Claude Code session.
 *
 * Pressing it jumps to whichever session needs attention, which makes a single
 * status key usable even with several projects open.
 */
@action({ UUID: "io.github.claude-deck.plugin.status" })
export class StatusAction extends DeckAction<StatusSettings> {
	protected override animates(_key: AnyAction<StatusSettings>, settings: StatusSettings): boolean {
		const session = runtime.store.resolve(settings.session);
		return session !== undefined && MOVING.includes(session.status);
	}

	protected override async draw(key: AnyAction<StatusSettings>, settings: StatusSettings): Promise<void> {
		if (!key.isKey()) {
			return;
		}

		if (!runtime.bridge.listening) {
			await key.setImage(
				tile({
					tone: "error",
					edge: "broken",
					headline: "Bridge down",
					subtitle: runtime.bridge.lastError ? "Check the port" : "Starting",
				}),
			);
			return;
		}

		const session = runtime.store.resolve(settings.session);
		if (!session) {
			await key.setImage(
				tile({
					tone: "offline",
					headline: "No session",
					subtitle: runtime.settings.hooksInstalled ? "Start Claude Code" : "Not connected yet",
				}),
			);
			return;
		}

		await key.setImage(tile(this.#describe(session, settings)));
	}

	/**
	 * Chooses what the key says about a session.
	 *
	 * The project name gets the headline because that is what tells two keys
	 * apart; the state is already being spoken by the border.
	 * @param session The session.
	 * @param settings The key's settings.
	 * @returns Tile options.
	 */
	#describe(session: SessionState, settings: StatusSettings) {
		const elapsed = session.turnStartedAt ? Date.now() - session.turnStartedAt : 0;
		const mode = settings.showPermissionMode === false ? undefined : MODES[session.permissionMode ?? "default"];

		const subtitle =
			session.status === "waiting" && session.pending
				? session.pending.summary
				: session.status === "error"
					? (session.lastError ?? WORDS.error)
					: session.status === "working"
						? (settings.showTool === false ? undefined : session.currentTool) ?? WORDS.working
						: WORDS[session.status];

		return {
			tone: TONES[session.status],
			edge: EDGES[session.status],
			phase: animationPhase(),
			eyebrow: mode ?? (session.status === "working" && elapsed ? duration(elapsed) : undefined),
			headline: settings.showProject === false ? WORDS[session.status] : session.project,
			subtitle,
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
