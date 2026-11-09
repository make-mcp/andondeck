import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, type AnyAction, type SessionScoped } from "./base.js";
import { runtime } from "../runtime.js";
import { tile } from "../ui/render.js";

type HaltSettings = SessionScoped & {
	/** Clear the queue as well, so nothing starts up again behind the brake. */
	clearQueue?: boolean;
} & JsonObject;

/**
 * Emergency brake for a running turn.
 *
 * No hook can interrupt a turn in flight, but `PreToolUse` can deny every call
 * that follows — which stops the agent from touching anything else and makes it
 * wind down and report back. The brake releases itself once the turn ends.
 */
@action({ UUID: "io.github.claude-deck.plugin.halt" })
export class HaltAction extends DeckAction<HaltSettings> {
	protected override async draw(key: AnyAction<HaltSettings>, settings: HaltSettings): Promise<void> {
		if (!key.isKey()) {
			return;
		}

		const session = runtime.store.resolve(settings.session);

		if (session?.haltedAt) {
			await key.setState(1);
			await key.setImage(
				tile({
					family: "control",
					tone: "error",
					solid: true,
					eyebrow: "Stopped",
					headline: "Resume",
					subtitle: `${session.haltedCalls} call${session.haltedCalls === 1 ? "" : "s"} blocked`,
				}),
			);
			return;
		}

		await key.setState(0);
		await key.setImage(
			tile({
				family: "control",
				tone: session?.status === "working" ? "error" : "offline",
				headline: "Stop",
				headlineTone: session?.status === "working" ? "state" : "ink",
				subtitle: session?.status === "working" ? (session.currentTool ?? session.project) : "Nothing running",
			}),
		);
	}

	override async onKeyDown(ev: KeyDownEvent<HaltSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const session = runtime.store.resolve(settings.session);

		if (!session) {
			await this.refuse(ev.action, "No Claude session yet");
			return;
		}

		if (session.haltedAt) {
			runtime.bridge.resume(session);
		} else {
			runtime.bridge.halt(session);

			// Releasing the brake should not immediately start queued work.
			if (settings.clearQueue) {
				runtime.store.clearQueue(settings.session);
			}
		}

		await ev.action.showOk();
		this.repaint();
	}
}
