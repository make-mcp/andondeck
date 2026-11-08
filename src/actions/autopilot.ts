import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, type AnyAction } from "./base.js";
import { runtime } from "../runtime.js";
import { duration, tile } from "../ui/render.js";
import type { AutoApproveMode } from "../bridge/types.js";

type AutopilotSettings = {
	/** What gets waved through: read-only tools, or everything. */
	scope?: Exclude<AutoApproveMode, "off">;
	/** Minutes before it switches itself off; 0 means until pressed again. */
	minutes?: number;
} & JsonObject;

/**
 * Approves tool calls on the user's behalf for a bounded stretch of time.
 *
 * Unlike a permission mode this is armed from the deck, always visible on the
 * key that armed it, counts itself down, and is one press away from off — so
 * it is hard to leave running by accident.
 */
@action({ UUID: "io.github.claude-deck.plugin.autopilot" })
export class AutopilotAction extends DeckAction<AutopilotSettings> {
	protected override async draw(key: AnyAction<AutopilotSettings>, settings: AutopilotSettings): Promise<void> {
		if (!key.isKey()) {
			return;
		}

		const scope = settings.scope ?? "safe";
		const active = runtime.bridge.autoApprove;
		const remaining = active.until ? active.until - Date.now() : 0;

		if (active.mode === "off") {
			await key.setState(0);
			await key.setImage(
				tile({
					tone: "accent",
					eyebrow: "Autopilot",
					headline: "Off",
					subtitle: scope === "all" ? "Arms everything" : "Arms read-only",
				}),
			);
			return;
		}

		// Armed is a mode, not a machine state, so it inverts rather than
		// borrowing the amber that means Claude is waiting on you. Approving
		// everything additionally carries a full red ring.
		await key.setState(1);
		await key.setImage(
			tile({
				tone: active.mode === "all" ? "error" : "accent",
				solid: true,
				eyebrow: "Autopilot",
				headline: active.mode === "all" ? "All tools" : "Read-only",
				subtitle: active.until ? duration(remaining) : "Until pressed",
				progress: active.until && settings.minutes ? remaining / (settings.minutes * 60_000) : undefined,
			}),
		);
	}

	override async onKeyDown(ev: KeyDownEvent<AutopilotSettings>): Promise<void> {
		const { scope = "safe", minutes = 15 } = ev.payload.settings;

		if (runtime.bridge.autoApprove.mode === "off") {
			runtime.bridge.setAutoApprove(scope, Math.max(0, minutes) * 60_000);
		} else {
			runtime.bridge.setAutoApprove("off", 0);
		}

		await ev.action.showOk();
		this.repaint();
	}
}
