import streamDeck, {
	SingletonAction,
	type DialAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { runtime } from "../runtime.js";

export type AnyAction<T extends JsonObject> = KeyAction<T> | DialAction<T>;

/** Every live action instance, so one ticker can repaint them all. */
const live = new Set<DeckAction<never>>();

let ticker: NodeJS.Timeout | undefined;

function repaintAll(): void {
	for (const action of live) {
		action.repaint();
	}
}

/**
 * Starts the shared repaint loop.
 *
 * Keys show elapsed turn time and countdowns, so they need a steady tick rather
 * than only repainting when the bridge reports a change.
 */
function ensureTicker(): void {
	if (ticker) {
		return;
	}

	runtime.on("change", repaintAll);
	ticker = setInterval(repaintAll, 1000);
	ticker.unref?.();
}

/**
 * Shared plumbing for Claude Deck actions: boots the bridge on first appearance,
 * keeps a copy of each instance's settings, and repaints on a tick.
 */
export abstract class DeckAction<T extends JsonObject = JsonObject> extends SingletonAction<T> {
	/** Latest settings per action context, so repaints need no round trip. */
	readonly #settings = new Map<string, T>();

	/** Draws one action instance. */
	protected abstract draw(action: AnyAction<T>, settings: T): Promise<void> | void;

	/** Settings for an action instance, falling back to an empty object. */
	protected settingsOf(action: AnyAction<T>): T {
		return this.#settings.get(action.id) ?? ({} as T);
	}

	/** Repaints every visible instance of this action. */
	public repaint(): void {
		for (const action of this.actions) {
			const typed = action as AnyAction<T>;
			try {
				void this.draw(typed, this.settingsOf(typed));
			} catch (error) {
				streamDeck.logger.error(`draw failed: ${(error as Error).message}`);
			}
		}
	}

	override async onWillAppear(ev: WillAppearEvent<T>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		ensureTicker();
		live.add(this as unknown as DeckAction<never>);

		await runtime.start();
		await this.onAppear?.(ev);
		await this.draw(ev.action as AnyAction<T>, ev.payload.settings);
	}

	override async onWillDisappear(ev: WillDisappearEvent<T>): Promise<void> {
		this.#settings.delete(ev.action.id);
		await this.onDisappear?.(ev);

		if (this.actions.length === 0) {
			live.delete(this as unknown as DeckAction<never>);
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		await this.draw(ev.action as AnyAction<T>, ev.payload.settings);
	}

	/** Optional hook for subclasses that need to register on appearance. */
	protected onAppear?(ev: WillAppearEvent<T>): Promise<void> | void;

	/** Optional hook for subclasses that need to clean up on disappearance. */
	protected onDisappear?(ev: WillDisappearEvent<T>): Promise<void> | void;
}

/** Settings shared by actions that target a specific session. */
export type SessionScoped = {
	/** `id:<uuid>`, `project:<name>`, `cwd:<path>`, or empty to follow the active session. */
	session?: string;
};
