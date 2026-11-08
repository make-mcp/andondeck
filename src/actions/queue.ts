import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, type AnyAction, type SessionScoped } from "./base.js";
import { runtime } from "../runtime.js";
import { keyLabel } from "../bridge/summarize.js";
import { tile } from "../ui/render.js";
import { readClipboard } from "../system/clipboard.js";

type QueueSettings = SessionScoped & {
	/** Where the prompt comes from. */
	source?: "text" | "clipboard";
	/** Wraps clipboard content, with `{}` marking where it is inserted. */
	template?: string;
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
		const fromClipboard = settings.source === "clipboard";
		const ready = fromClipboard || Boolean(settings.text);
		const caption =
			settings.label || (fromClipboard ? "Clipboard" : settings.text ? keyLabel(settings.text, 28) : "Set a prompt");

		const idleHint = session?.status === "idle" && queued > 0 && !runtime.settings.idleWake;

		await key.setImage(
			tile({
				tone: ready ? (idleHint ? "waiting" : "accent") : "offline",
				eyebrow: "queue",
				glyph: fromClipboard ? "⎘" : "+",
				title: caption,
				subtitle: idleHint ? "Idle — send a message" : session ? session.project : "No session",
				badge: queued || undefined,
			}),
		);
	}

	override async onKeyDown(ev: KeyDownEvent<QueueSettings>): Promise<void> {
		const { text, session, label, allowDuplicates, source, template } = ev.payload.settings;
		const prompt = source === "clipboard" ? await this.#fromClipboard(template) : text?.trim();

		if (!prompt) {
			await this.refuse(ev.action, source === "clipboard" ? "Clipboard is empty" : "Set a prompt first");
			return;
		}

		if (!allowDuplicates && runtime.store.queueFor(session).some((item) => item.text === prompt)) {
			await this.refuse(ev.action, "Already queued");
			return;
		}

		runtime.store.enqueue(prompt, session, label || (source === "clipboard" ? keyLabel(prompt, 28) : undefined));
		await ev.action.showOk();
		this.repaint();
	}

	/**
	 * Builds a prompt from the clipboard.
	 * @param template Optional wrapper; `{}` marks where the clipboard goes.
	 * @returns The prompt, or `undefined` when the clipboard had nothing usable.
	 */
	async #fromClipboard(template?: string): Promise<string | undefined> {
		const clipboard = await readClipboard();
		if (!clipboard) {
			return undefined;
		}

		return template?.includes("{}") ? template.replace("{}", clipboard) : (template ? `${template}\n\n${clipboard}` : clipboard);
	}
}
