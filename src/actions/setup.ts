import streamDeck, {
	action,
	type KeyDownEvent,
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
	0: "profiles/Claude Deck",
	1: "profiles/Claude Deck Mini",
	2: "profiles/Claude Deck XL",
	7: "profiles/Claude Deck Plus",
	9: "profiles/Claude Deck Neo",
};

/**
 * One-time connection between Claude Code and the deck.
 *
 * Pressing it writes the Claude Deck hooks into Claude Code's settings — or
 * removes them again — and the key reflects whether the bridge is healthy.
 */
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
				subtitle: connected ? `${sessions} session${sessions === 1 ? "" : "s"}` : "Installs the hooks",
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
	override async onKeyDown(ev: KeyDownEvent<SetupSettings>): Promise<void> {
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

	/** Switches every connected deck to the layout built for it. */
	async #useProfile(): Promise<void> {
		for (const device of streamDeck.devices) {
			const profile = PROFILE_FOR_DEVICE[device.type as number];
			if (!profile || !device.isConnected) {
				continue;
			}

			streamDeck.logger.info(`switching ${device.name} to ${profile}`);
			await streamDeck.profiles.switchToProfile(device.id, profile);
		}
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SetupSettings>): Promise<void> {
		const message = ev.payload as SetupMessage;

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
