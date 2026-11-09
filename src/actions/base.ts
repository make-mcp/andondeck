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
import { tile } from "../ui/render.js";

export type AnyAction<T extends JsonObject> = KeyAction<T> | DialAction<T>;

/** How long an explanation stays on the key after a press that did nothing. */
const NOTICE_MS = 2500;

/** Frame interval for keys whose border is animating. */
const FRAME_MS = 125;

/** Frames between full repaints of every key, animating or not. */
const FULL_REPAINT_EVERY = 8;

/** Every live action instance, so one ticker can repaint them all. */
const live = new Set<DeckAction<never>>();

let ticker: NodeJS.Timeout | undefined;
let frame = 0;

/** 0–1 position of the shared animation cycle, two seconds per loop. */
let phase = 0;

export function animationPhase(): number {
	return phase;
}

/**
 * Starts the shared repaint loop.
 *
 * Two rates, for a reason: everything needs a second-by-second repaint for
 * elapsed times, but only keys whose border is moving need frames, and
 * repainting a full XL at eight frames a second would flood the socket for no
 * visible gain.
 */
function ensureTicker(): void {
	if (ticker) {
		return;
	}

	runtime.on("change", () => {
		for (const action of live) {
			action.repaint();
		}
	});

	ticker = setInterval(() => {
		frame += 1;
		phase = (frame % (2000 / FRAME_MS)) / (2000 / FRAME_MS);

		const everything = frame % FULL_REPAINT_EVERY === 0;
		for (const action of live) {
			action.repaint(everything ? "all" : "animating");
		}
	}, FRAME_MS);
	ticker.unref?.();
}

/**
 * Shared plumbing for Andon Deck actions: boots the bridge on first appearance,
 * keeps a copy of each instance's settings, and repaints on a tick.
 */
export abstract class DeckAction<T extends JsonObject = JsonObject> extends SingletonAction<T> {
	/** Latest settings per action context, so repaints need no round trip. */
	readonly #settings = new Map<string, T>();

	/** Short-lived explanations shown in place of the key's normal face. */
	readonly #notices = new Map<string, { text: string; until: number; kind: "refused" | "done" }>();

	/** Draws one action instance. */
	protected abstract draw(action: AnyAction<T>, settings: T): Promise<void> | void;

	/** Settings for an action instance, falling back to an empty object. */
	protected settingsOf(action: AnyAction<T>): T {
		return this.#settings.get(action.id) ?? ({} as T);
	}

	/**
	 * Explains on the key why a press did nothing.
	 *
	 * A bare alert badge is indistinguishable from a broken plugin, which is
	 * exactly the wrong impression when the real answer is "no session yet" or
	 * "this key has no prompt".
	 * @param action The action instance.
	 * @param reason Short reason, a few words at most.
	 */
	protected async refuse(action: AnyAction<T>, reason: string): Promise<void> {
		// Before the hooks are installed every key is blocked for the same
		// reason, and naming it beats nine different symptoms.
		const text = runtime.settings.hooksInstalled ? reason : "Press Connect Claude Code first";

		this.#notices.set(action.id, { text, until: Date.now() + NOTICE_MS, kind: "refused" });
		streamDeck.logger.info(`${this.manifestId} refused: ${text}`);

		await action.showAlert();
		this.repaint();
	}

	/**
	 * Says on the key what a press did, when the answer needs more than a tick —
	 * "copied, now paste it", for example. Unlike {@link refuse}, no alert.
	 * @param action The action instance.
	 * @param text Short message, a few words at most.
	 */
	protected async inform(action: AnyAction<T>, text: string): Promise<void> {
		this.#notices.set(action.id, { text, until: Date.now() + NOTICE_MS, kind: "done" });
		streamDeck.logger.info(`${this.manifestId}: ${text}`);

		if (action.isKey()) {
			await action.showOk();
		}
		this.repaint();
	}

	/**
	 * Whether this instance's border is moving and so needs frames.
	 * @param _action The action instance.
	 * @param _settings Its settings.
	 * @returns `true` to repaint at frame rate.
	 */
	protected animates(_action: AnyAction<T>, _settings: T): boolean {
		return false;
	}

	/**
	 * Repaints visible instances of this action.
	 * @param scope `all`, or only the instances that are animating.
	 */
	public repaint(scope: "all" | "animating" = "all"): void {
		// The first appearance starts the runtime; until it is up there is
		// nothing to draw from, and onWillAppear draws once it is.
		if (!runtime.started) {
			return;
		}

		for (const action of this.actions) {
			const typed = action as AnyAction<T>;

			try {
				const settings = this.settingsOf(typed);
				if (scope === "animating" && !this.animates(typed, settings)) {
					continue;
				}

				const notice = this.#notices.get(typed.id);
				if (notice && Date.now() < notice.until) {
					if (typed.isKey()) {
						void typed.setImage(
							notice.kind === "refused"
								? tile({ tone: "waiting", eyebrow: "nothing to do", glyph: "·", title: notice.text })
								: tile({ tone: "working", eyebrow: "done", glyph: "✓", title: notice.text, ghost: false }),
						);
						continue;
					}
				} else if (notice) {
					this.#notices.delete(typed.id);
				}

				void this.draw(typed, settings);
			} catch (error) {
				streamDeck.logger.error(`draw failed for ${this.manifestId}: ${(error as Error).stack ?? String(error)}`);
			}
		}
	}

	override async onWillDisappear(ev: WillDisappearEvent<T>): Promise<void> {
		this.#settings.delete(ev.action.id);
		this.#notices.delete(ev.action.id);
		await this.onDisappear?.(ev);

		if (this.actions.length === 0) {
			live.delete(this as unknown as DeckAction<never>);
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
