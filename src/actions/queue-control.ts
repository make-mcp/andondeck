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
import { runtime } from "../runtime.js";
import { keyLabel } from "../bridge/summarize.js";
import { tile } from "../ui/render.js";

/** What a key press does; dials always browse and apply. */
type QueueMode = "clear" | "drop-next" | "promote" | "browse";

type QueueControlSettings = SessionScoped & {
	mode?: QueueMode;
} & JsonObject;

/** Dial cursor per action context, so rotating keeps its place between repaints. */
const cursors = new Map<string, number>();

/**
 * Inspect and edit the prompt queue.
 *
 * On a dial, rotating scrolls the queue and pressing applies the configured
 * action to the entry under the cursor.
 */
@action({ UUID: "io.github.claude-deck.plugin.queue-control" })
export class QueueControlAction extends DeckAction<QueueControlSettings> {
	protected override async draw(unit: AnyAction<QueueControlSettings>, settings: QueueControlSettings): Promise<void> {
		const queue = runtime.store.queueFor(settings.session);
		const mode: QueueMode = settings.mode ?? "browse";

		if (unit.isDial()) {
			const index = this.#cursor(unit.id, queue.length);
			const item = queue[index];

			await unit.setFeedback({
				title: queue.length ? `Queue ${index + 1}/${queue.length}` : "Queue empty",
				value: item ? keyLabel(item.label || item.text, 28) : "—",
				icon: tile({ tone: queue.length ? "accent" : "offline", glyph: String(queue.length) }),
			});
			return;
		}

		if (!unit.isKey()) {
			return;
		}

		const labels: Record<QueueMode, { glyph: string; title: string }> = {
			clear: { glyph: "⌫", title: "Clear queue" },
			"drop-next": { glyph: "−", title: "Drop next" },
			promote: { glyph: "↑", title: "Promote last" },
			browse: { glyph: "≡", title: "Queue" },
		};

		await unit.setImage(
			tile({
				tone: queue.length ? "accent" : "offline",
				eyebrow: "Queue",
				headline: labels[mode].title,
				subtitle: queue.length ? keyLabel(queue[0].label || queue[0].text, 22) : "Empty",
				badge: queue.length || undefined,
			}),
		);
	}

	/** Clamps a stored cursor to the current queue length. */
	#cursor(context: string, length: number): number {
		if (length === 0) {
			return 0;
		}

		const raw = cursors.get(context) ?? 0;
		const clamped = ((raw % length) + length) % length;
		cursors.set(context, clamped);
		return clamped;
	}

	override async onKeyDown(ev: KeyDownEvent<QueueControlSettings>): Promise<void> {
		const { session, mode = "browse" } = ev.payload.settings;
		const queue = runtime.store.queueFor(session);

		if (queue.length === 0) {
			await this.refuse(ev.action, "Queue is empty");
			return;
		}

		switch (mode) {
			case "clear":
				runtime.store.clearQueue(session);
				break;
			case "drop-next":
				runtime.store.removeQueued(0, session);
				break;
			case "promote":
				runtime.store.promoteQueued(queue.length - 1, session);
				break;
			case "browse":
				runtime.store.promoteQueued(1, session);
				break;
		}

		await ev.action.showOk();
		this.repaint();
	}

	override async onDialRotate(ev: DialRotateEvent<QueueControlSettings>): Promise<void> {
		const queue = runtime.store.queueFor(ev.payload.settings.session);
		if (queue.length === 0) {
			return;
		}

		cursors.set(ev.action.id, (cursors.get(ev.action.id) ?? 0) + ev.payload.ticks);
		await this.draw(ev.action as DialAction<QueueControlSettings>, ev.payload.settings);
	}

	override async onDialDown(ev: DialDownEvent<QueueControlSettings>): Promise<void> {
		await this.#apply(ev.action.id, ev.payload.settings);
	}

	override async onTouchTap(ev: TouchTapEvent<QueueControlSettings>): Promise<void> {
		await this.#apply(ev.action.id, ev.payload.settings);
	}

	/** Applies the configured mode to the entry under the dial cursor. */
	async #apply(context: string, settings: QueueControlSettings): Promise<void> {
		const queue = runtime.store.queueFor(settings.session);
		if (queue.length === 0) {
			return;
		}

		const index = this.#cursor(context, queue.length);

		switch (settings.mode ?? "browse") {
			case "clear":
				runtime.store.clearQueue(settings.session);
				break;
			case "drop-next":
				runtime.store.removeQueued(index, settings.session);
				break;
			default:
				runtime.store.promoteQueued(index, settings.session);
				cursors.set(context, 0);
				break;
		}

		this.repaint();
	}
}
