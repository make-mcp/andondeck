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
		const label = scope === "all" ? "All tools" : "Read-only";
		const active = runtime.bridge.autoApprove;
		const remaining = active.until ? active.until - Date.now() : 0;

		// This key's own mode is on: flood it, so it is unmistakably the one running.
		// Approving everything floods red rather than the quiet accent.
		if (active.mode === scope) {
			await key.setState(1);
			await key.setImage(
				tile({
					family: "control",
					tone: scope === "all" ? "error" : "accent",
					solid: true,
					eyebrow: "Autopilot",
					headline: label,
					subtitle: active.until ? `on · ${duration(remaining)}` : "on",
					progress: active.until && settings.minutes ? remaining / (settings.minutes * 60_000) : undefined,
				}),
			);
			return;
		}

		await key.setState(0);

		// The other mode is on: this key is one press from taking over. A still,
		// dashed ring says "available" without looking like it is running.
		if (active.mode !== "off") {
			await key.setImage(
				tile({
					family: "control",
					ghost: "sleep",
					tone: scope === "all" ? "error" : "accent",
					edge: "standby",
					eyebrow: "Autopilot",
					headline: label,
					subtitle: "press to switch",
				}),
			);
			return;
		}

		await key.setImage(
			tile({
				family: "control",
				ghost: "sleep",
				tone: "accent",
				// Two autopilot keys on one deck must not look alike while both are
				// off, so the scope is the headline and "off" the caption.
				eyebrow: "Autopilot",
				headline: label,
				subtitle: settings.minutes ? `off · ${settings.minutes} min` : "off",
			}),
		);
	}

	override async onKeyDown(ev: KeyDownEvent<AutopilotSettings>): Promise<void> {
		const { scope = "safe", minutes = 15 } = ev.payload.settings;

		// A key turns its own mode off, and switches to its own mode from any
		// other — so every press does what the key says.
		if (runtime.bridge.autoApprove.mode === scope) {
			runtime.bridge.setAutoApprove("off", 0);
		} else {
			runtime.bridge.setAutoApprove(scope, Math.max(0, minutes) * 60_000);
		}

		await ev.action.showOk();
		this.repaint();
	}
}
