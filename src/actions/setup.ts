import streamDeck, {
	action,
	type KeyDownEvent,
	type KeyUpEvent,
	type SendToPluginEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import { DeckAction, type AnyAction } from "./base.js";
import { runtime } from "../runtime.js";
import { tile } from "../ui/render.js";

type SetupSettings = JsonObject;

/** `sdpi-button invoke="…"` posts its action name as `event`. */
type SetupMessage = {
	event?: "connect" | "disconnect" | "diagnostics" | "useProfile";
};

/**
 * The bundled profile for each device type, keyed by Stream Deck's own numbers.
 *
 * Installing a profile is not the same as landing on it, and a profile the user
 * cannot find is the same as no profile at all — so the setup can switch to it
 * directly.
 */
const PROFILE_FOR_DEVICE: Record<number, string> = {
	0: "Claude Deck",
	1: "Claude Deck Mini",
	2: "Claude Deck XL",
	7: "Claude Deck Plus",
	9: "Claude Deck Neo",
};

/** Hold the key at least this long to ask for the bundled layout. */
const LONG_PRESS_MS = 900;

/**
 * One-time connection between Claude Code and the deck.
 *
 * Pressing it writes the Claude Deck hooks into Claude Code's settings — or
 * removes them again — and the key reflects whether the bridge is healthy.
 */
/** When each Connect key went down, so a hold can be told from a tap. */
const pressedAt = new Map<string, number>();

@action({ UUID: "io.github.claude-deck.plugin.setup" })
export class SetupAction extends DeckAction<SetupSettings> {
	protected override async draw(key: AnyAction<SetupSettings>): Promise<void> {
		if (!key.isKey()) {
			return;
		}

		const connected = runtime.settings.hooksInstalled && runtime.bridge.listening;
		await key.setState(connected ? 1 : 0);

		if (!runtime.bridge.listening) {
			await key.setImage(
				tile({
					tone: "error",
					edge: "broken",
					eyebrow: "Bridge",
					headline: "Blocked",
					headlineTone: "state",
					subtitle: `Port ${runtime.settings.port}`,
				}),
			);
			return;
		}

		const sessions = runtime.store.list().length;
		await key.setImage(
			tile({
				tone: connected ? "working" : "accent",
				eyebrow: "Claude Deck",
				headline: connected ? "Connected" : "Connect",
				headlineTone: connected ? "state" : "ink",
				subtitle: connected ? `Hold for the layout` : "Installs the hooks",
				badge: connected && sessions === 0 ? "?" : undefined,
			}),
		);
	}

	/**
	 * Connects, or re-checks an existing connection.
	 *
	 * Deliberately not a toggle: pressing a key labelled "Connected" to see what
	 * it does should not silently disconnect you. Removing the hooks lives in
	 * this action's settings, where it cannot happen by accident.
	 */
	override onKeyDown(ev: KeyDownEvent<SetupSettings>): void {
		pressedAt.set(ev.action.id, Date.now());
	}

	/**
	 * Short press connects or re-checks; holding loads the bundled layout.
	 *
	 * The layout is also a button in this action's settings, but a key that can
	 * do it on its own does not depend on the inspector being open.
	 */
	override async onKeyUp(ev: KeyUpEvent<SetupSettings>): Promise<void> {
		const held = Date.now() - (pressedAt.get(ev.action.id) ?? Date.now());
		pressedAt.delete(ev.action.id);

		if (held >= LONG_PRESS_MS) {
			const switched = await this.#useProfile();
			await (switched > 0 ? ev.action.showOk() : this.refuse(ev.action, "No layout for this deck"));
			return;
		}

		try {
			if (runtime.settings.hooksInstalled) {
				const moved = await runtime.reconcile();
				streamDeck.logger.info(moved ? `hooks re-pointed at ${moved}` : "hooks already up to date");
			} else {
				streamDeck.logger.info(`hooks written to ${await runtime.connect()}`);
			}

			await ev.action.showOk();
		} catch (error) {
			streamDeck.logger.error(`setup failed: ${(error as Error).stack ?? String(error)}`);
			await ev.action.showAlert();
		}

		this.repaint();
	}

	/**
	 * Switches every connected deck to the layout built for it.
	 * @returns How many decks were switched.
	 */
	async #useProfile(): Promise<number> {
		let switched = 0;

		for (const device of streamDeck.devices) {
			const profile = PROFILE_FOR_DEVICE[device.type as number];
			streamDeck.logger.info(`device ${device.name} type=${device.type} connected=${device.isConnected} profile=${profile ?? "none"}`);

			if (!profile || !device.isConnected) {
				continue;
			}

			try {
				await streamDeck.profiles.switchToProfile(device.id, profile);
				switched += 1;
			} catch (error) {
				streamDeck.logger.error(`switchToProfile failed: ${(error as Error).message}`);
			}
		}

		return switched;
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SetupSettings>): Promise<void> {
		const message = ev.payload as SetupMessage;
		if (message.event !== "diagnostics") {
			streamDeck.logger.info(`property inspector: ${message.event}`);
		}

		try {
			switch (message.event) {
				case "connect": {
					await runtime.connect();
					break;
				}
				case "disconnect": {
					await runtime.disconnect();
					break;
				}
				case "useProfile": {
					await this.#useProfile();
					break;
				}
				default:
					break;
			}
		} catch (error) {
			await streamDeck.ui.sendToPropertyInspector({
				event: "error",
				message: (error as Error).message,
			});
		}

		await streamDeck.ui.sendToPropertyInspector({
			event: "diagnostics",
			data: (await runtime.diagnostics()) as JsonValue,
		});

		this.repaint();
	}
}
