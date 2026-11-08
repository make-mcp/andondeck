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
	event?: "connect" | "disconnect" | "diagnostics";
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
					eyebrow: "bridge",
					glyph: "!",
					title: "Port blocked",
					subtitle: `Port ${runtime.settings.port}`,
				}),
			);
			return;
		}

		const sessions = runtime.store.list().length;
		await key.setImage(
			tile({
				tone: connected ? "idle" : "offline",
				eyebrow: "claude deck",
				glyph: connected ? "✓" : "⚯",
				title: connected ? "Connected" : "Connect",
				subtitle: connected ? `${sessions} session${sessions === 1 ? "" : "s"}` : "Press to install hooks",
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
