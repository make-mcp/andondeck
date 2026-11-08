import {
	action,
	type KeyDownEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, type AnyAction, type SessionScoped } from "./base.js";
import { runtime } from "../runtime.js";
import { duration, tile } from "../ui/render.js";

type ApproveSettings = SessionScoped & {
	/** What this key answers with. */
	verdict?: "allow" | "deny";
	/** Require a second press within a few seconds before answering. */
	confirm?: boolean;
} & JsonObject;

/** How long a first press stays armed when confirmation is on. */
const ARM_WINDOW_MS = 4000;

/** Contexts armed by a first press, with the time they were armed. */
const armed = new Map<string, number>();

/**
 * Answers Claude Code permission requests from the deck.
 *
 * Requests are only held open while one of these keys is actually visible —
 * otherwise Claude Code shows its own prompt in the terminal as usual.
 */
@action({ UUID: "io.github.claude-deck.plugin.approve" })
export class ApproveAction extends DeckAction<ApproveSettings> {
	protected override onAppear(ev: WillAppearEvent<ApproveSettings>): void {
		runtime.registerApprover(ev.action.id);
	}

	protected override onDisappear(ev: WillDisappearEvent<ApproveSettings>): void {
		runtime.unregisterApprover(ev.action.id);
		armed.delete(ev.action.id);
	}

	protected override async draw(key: AnyAction<ApproveSettings>, settings: ApproveSettings): Promise<void> {
		if (!key.isKey()) {
			return;
		}

		const verdict = settings.verdict ?? "allow";
		const match = runtime.store.firstPending(settings.session);
		await key.setState(verdict === "allow" ? 0 : 1);

		if (!match) {
			await key.setImage(
				tile({
					tone: "offline",
					eyebrow: verdict,
					glyph: verdict === "allow" ? "✓" : "✕",
					title: "Nothing to answer",
					subtitle: runtime.settings.deckApprovals ? "Watching" : "Deck approvals off",
				}),
			);
			return;
		}

		const { pending, session } = match;
		const remaining = Math.max(0, pending.expiresAt - Date.now());
		const isArmed = Date.now() - (armed.get(key.id) ?? 0) < ARM_WINDOW_MS;

		await key.setImage(
			tile({
				tone: isArmed ? "working" : verdict === "allow" ? "idle" : "error",
				solid: isArmed,
				eyebrow: isArmed ? "press again" : `${verdict} · ${duration(remaining)}`,
				glyph: verdict === "allow" ? "✓" : "✕",
				title: pending.toolName,
				subtitle: pending.summary.replace(`${pending.toolName}: `, "") || session.project,
				progress: remaining / Math.max(1, pending.expiresAt - pending.receivedAt),
			}),
		);
	}

	override async onKeyDown(ev: KeyDownEvent<ApproveSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const verdict = settings.verdict ?? "allow";
		const match = runtime.store.firstPending(settings.session);

		if (!match) {
			await this.refuse(ev.action, runtime.settings.deckApprovals ? "Nothing to approve" : "Deck approvals are off");
			return;
		}

		if (settings.confirm && Date.now() - (armed.get(ev.action.id) ?? 0) >= ARM_WINDOW_MS) {
			armed.set(ev.action.id, Date.now());
			this.repaint();
			return;
		}

		armed.delete(ev.action.id);

		if (runtime.bridge.decide(match.pending.toolUseId, verdict)) {
			await ev.action.showOk();
		} else {
			// The request fell through to the terminal before we could answer it.
			await this.refuse(ev.action, "Answered in the terminal");
		}

		this.repaint();
	}
}
