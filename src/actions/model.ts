import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, type AnyAction, type SessionScoped } from "./base.js";
import { runtime } from "../runtime.js";
import { writeClipboard } from "../system/clipboard.js";
import { tile } from "../ui/render.js";

type ModelSettings = SessionScoped & {
	/** Alias to switch to; empty cycles through {@link CYCLE}. */
	model?: string;
} & JsonObject;

/**
 * Aliases rather than pinned model ids.
 *
 * Claude Code resolves these to whatever is current, so a key set up today
 * keeps working after the next model release.
 */
const CYCLE = ["default", "opus", "sonnet", "haiku"] as const;

/** Shortens a canonical model id to something that fits a key. */
function shortName(model?: string): string {
	if (!model) {
		return "unknown";
	}

	const family = /opus|sonnet|haiku|fable/i.exec(model)?.[0];
	return family ? family[0].toUpperCase() + family.slice(1).toLowerCase() : model.replace(/^claude-/, "").slice(0, 12);
}

/**
 * Shows the session's model and switches it.
 *
 * The switch travels as a `/model` command through the same queue as any other
 * prompt, so it lands at the next turn boundary rather than mid-turn.
 */
@action({ UUID: "com.andondeck.plugin.model" })
export class ModelAction extends DeckAction<ModelSettings> {
	protected override async draw(key: AnyAction<ModelSettings>, settings: ModelSettings): Promise<void> {
		if (!key.isKey()) {
			return;
		}

		const session = runtime.store.resolve(settings.session);
		const target = settings.model;

		await key.setImage(
			tile({
				family: "control",
				ghost: "stand",
				tone: session ? "accent" : "offline",
				eyebrow: target ? `Switch to ${target}` : "Model",
				headline: shortName(session?.model),
				subtitle: session?.project,
			}),
		);
	}

	override async onKeyDown(ev: KeyDownEvent<ModelSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const session = runtime.store.resolve(settings.session);

		if (!session) {
			await this.refuse(ev.action, "No Claude session yet");
			return;
		}

		// Claude Code runs /model only when typed at its own prompt; no hook can
		// switch it. Leave the command ready to paste rather than pretend.
		const target = settings.model || this.#next(session.model);
		const command = `/model ${target}`;
		const copied = await writeClipboard(command);
		await (copied ? this.inform(ev.action, `Copied ${command} — paste it`) : this.refuse(ev.action, `Type ${command}`));
	}

	/** Picks the next alias after the one currently in use. */
	#next(current?: string): string {
		const index = CYCLE.findIndex((alias) => alias !== "default" && new RegExp(alias, "i").test(current ?? ""));
		return CYCLE[(index + 1) % CYCLE.length];
	}
}
