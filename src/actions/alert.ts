import streamDeck, {
	action,
	SingletonAction,
	type KeyAction,
	type KeyDownEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import type { JsonObject } from "@elgato/utils";

import { runtime } from "../runtime.js";
import { alertKey, alertScene } from "../ui/render.js";

/**
 * Wave speed. Two frames a second is a wave to the eye, and since only the
 * few keys that Clawd's arm crosses change between frames, it costs a handful
 * of images per second even on an XL.
 */
const FRAME_MS = 500;

/** Last image sent per key, so unchanged keys are not sent again. */
const sent = new Map<string, string>();

let ticker: NodeJS.Timeout | undefined;
let frame = 0;

/**
 * One key of the full-deck alert.
 *
 * The bundled "… Alert" profiles fill every key with this action. Each shows
 * its own window onto one large picture of Clawd waving, so the whole deck
 * becomes the notification. Any press goes back to where you were.
 */
@action({ UUID: "com.andondeck.plugin.alert" })
export class AlertAction extends SingletonAction {
	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		await runtime.start();
		sent.delete(ev.action.id);
		this.#ensureTicker();
		this.#paint();
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		sent.delete(ev.action.id);
		if (![...this.actions].some((unit) => unit.id !== ev.action.id)) {
			clearInterval(ticker);
			ticker = undefined;
		}
		runtime.alertLeft(ev.action.device.id);
	}

	override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
		await runtime.dismissAlert();
	}

	#ensureTicker(): void {
		if (ticker) {
			return;
		}
		ticker = setInterval(() => {
			frame += 1;
			this.#paint();
		}, FRAME_MS);
		ticker.unref?.();
	}

	#paint(): void {
		const project = runtime.store.list().find((session) => session.status === "waiting")?.project;
		const scenes = new Map<string, string>();

		for (const unit of this.actions) {
			if (!unit.isKey()) {
				continue;
			}
			const key = unit as KeyAction<JsonObject>;
			const at = key.coordinates;
			if (!at) {
				continue;
			}

			// One scene per device: a Mini and an XL side by side each get their own picture.
			const { columns, rows } = key.device.size;
			const sceneId = `${key.device.id}:${columns}x${rows}`;
			let scene = scenes.get(sceneId);
			if (!scene) {
				scene = alertScene(columns, rows, frame, project);
				scenes.set(sceneId, scene);
			}

			const image = alertKey(scene, at.column, at.row);
			if (sent.get(key.id) === image) {
				continue;
			}
			sent.set(key.id, image);
			key.setImage(image).catch((error: Error) => streamDeck.logger.warn(`alert key: ${error.message}`));
		}
	}
}
