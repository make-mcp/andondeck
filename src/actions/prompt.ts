import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, type AnyAction, type SessionScoped } from "./base.js";
import { runtime } from "../runtime.js";
import { keyLabel } from "../bridge/summarize.js";
import { tile } from "../ui/render.js";

type PromptSettings = SessionScoped & {
	/** Preset id, or `custom` to use {@link PromptSettings.text}. */
	preset?: string;
	text?: string;
	label?: string;
	/** Put this prompt at the front of the queue instead of the back. */
	priority?: boolean;
	/** Drop anything already queued before adding this one. */
	replaceQueue?: boolean;
} & JsonObject;

export type Preset = {
	id: string;
	label: string;
	text: string;
	glyph: string;
};

/**
 * One-tap prompts and slash commands.
 *
 * Slash commands travel the same path as any other prompt: they are handed to
 * Claude Code as the next turn's input, so `/compact` or `/review` behave
 * exactly as if typed.
 */
export const PRESETS: Preset[] = [
	{ id: "compact", label: "Compact", text: "/compact", glyph: "⟳" },
	{ id: "clear", label: "Clear", text: "/clear", glyph: "⌫" },
	{ id: "review", label: "Review", text: "/review", glyph: "⚑" },
	{ id: "continue", label: "Continue", text: "Continue where you left off.", glyph: "▸" },
	{ id: "tests", label: "Run tests", text: "Run the test suite and fix anything that fails.", glyph: "✓" },
	{ id: "commit", label: "Commit", text: "Commit the current changes with a clear message.", glyph: "◆" },
	{ id: "explain", label: "Explain", text: "Explain what you just changed and why.", glyph: "?" },
	{ id: "summarize", label: "Summarize", text: "Summarize the current state of this task in a few bullets.", glyph: "≡" },
	{ id: "custom", label: "Custom…", text: "", glyph: "✎" },
];

/** Used when a key is dragged in and pressed before anyone opens its settings. */
const DEFAULT_PRESET = "continue";

function resolvePreset(settings: PromptSettings): { text: string; label: string; glyph: string } {
	const preset = PRESETS.find((entry) => entry.id === (settings.preset ?? DEFAULT_PRESET));

	if (!preset || preset.id === "custom") {
		const text = settings.text ?? "";
		return { text, label: settings.label || (text ? keyLabel(text, 26) : "Set a prompt"), glyph: "✎" };
	}



	return { text: preset.text, label: settings.label || preset.label, glyph: preset.glyph };
}

@action({ UUID: "io.github.claude-deck.plugin.prompt" })
export class PromptAction extends DeckAction<PromptSettings> {
	protected override async draw(key: AnyAction<PromptSettings>, settings: PromptSettings): Promise<void> {
		if (!key.isKey()) {
			return;
		}

		const { text, label, glyph } = resolvePreset(settings);
		const session = runtime.store.resolve(settings.session);

		await key.setImage(
			tile({
				tone: text ? "accent" : "offline",
				eyebrow: glyph,
				headline: label,
				subtitle: session ? (session.status === "working" ? "Queues next" : "Sends next") : "No session",
				badge: settings.priority ? "↑" : undefined,
			}),
		);
	}

	override async onKeyDown(ev: KeyDownEvent<PromptSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const { text, label } = resolvePreset(settings);

		if (!text.trim()) {
			await this.refuse(ev.action, "Set a prompt first");
			return;
		}

		if (settings.replaceQueue) {
			runtime.store.clearQueue(settings.session);
		}

		runtime.store.enqueue(text, settings.session, label);

		if (settings.priority) {
			const queue = runtime.store.queueFor(settings.session);
			runtime.store.promoteQueued(queue.length - 1, settings.session);
		}

		await ev.action.showOk();
		this.repaint();
	}
}
