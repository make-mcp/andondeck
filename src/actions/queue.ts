import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, type AnyAction, type SessionScoped } from "./base.js";
import { runtime } from "../runtime.js";
import { keyLabel } from "../bridge/summarize.js";
import { tile } from "../ui/render.js";

type QueueSettings = SessionScoped & {
	/** Prompt text queued when the key is pressed. */
	text?: string;
	/** Short caption for the key; defaults to the start of the prompt. */
	label?: string;
	/** Queue the same prompt more than once. */
	allowDuplicates?: boolean;
} & JsonObject;

/**
 * Queues a prompt for the next turn.
 *
 * While Claude is working the `Stop` hook feeds it straight back in; when the
 * session is already idle the optional idle-wake helper delivers it instead.
 */
@action({ UUID: "io.github.claude-deck.plugin.queue" })
export class QueuePromptAction extends DeckAction<QueueSettings> {
	protected override async draw(key: AnyAction<QueueSettings>, settings: QueueSettings): Promise<void> {
		if (!key.isKey()) {
			return;
		}

		const session = runtime.store.resolve(settings.session);
		const queued = runtime.store.queueFor(settings.session).length;
		const caption = settings.label || (settings.text ? keyLabel(settings.text, 28) : "Set a prompt");

		const idleHint = session?.status === "idle" && queued > 0 && !runtime.settings.idleWake;

		await key.setImage(
			tile({
				tone: settings.text ? (idleHint ? "waiting" : "accent") : "offline",
				eyebrow: "queue",
				glyph: "+",
				title: caption,
				subtitle: idleHint ? "Idle — send a message" : session ? session.project : "No session",
				badge: queued || undefined,
			}),
		);
	}

	override async onKeyDown(ev: KeyDownEvent<QueueSettings>): Promise<void> {
		const { text, session, label, allowDuplicates } = ev.payload.settings;

		if (!text?.trim()) {
			await ev.action.showAlert();
			return;
		}

		if (!allowDuplicates && runtime.store.queueFor(session).some((item) => item.text === text)) {
			await ev.action.showAlert();
			return;
		}

		runtime.store.enqueue(text, session, label);
		await ev.action.showOk();
		this.repaint();
	}
}
