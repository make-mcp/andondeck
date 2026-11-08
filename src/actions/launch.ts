import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { DeckAction, type AnyAction } from "./base.js";
import { runtime } from "../runtime.js";
import { keyLabel } from "../bridge/summarize.js";
import { tile } from "../ui/render.js";
import { launchClaude } from "../system/launcher.js";

type LaunchSettings = {
	/** Folder to start in, as Claude Code's side of the filesystem sees it. */
	cwd?: string;
	label?: string;
	/** Resume the most recent conversation in that folder. */
	resume?: boolean;
	model?: string;
	permissionMode?: string;
	/** Opening message, so the session starts already working. */
	prompt?: string;
} & JsonObject;

/** How long the key acknowledges a launch before returning to its normal face. */
const CONFIRM_MS = 6000;

/** Contexts that launched something recently, with the time they did. */
const launched = new Map<string, number>();

/**
 * Opens a terminal with an interactive Claude Code session.
 *
 * Every other key on the deck needs a session to exist first; this is the one
 * that can create one, which is what makes a cold deck useful.
 */
@action({ UUID: "io.github.claude-deck.plugin.launch" })
export class LaunchAction extends DeckAction<LaunchSettings> {
	protected override async draw(key: AnyAction<LaunchSettings>, settings: LaunchSettings): Promise<void> {
		if (!key.isKey()) {
			return;
		}

		const folder = settings.cwd || runtime.settings.defaultCwd;
		const caption = settings.label || (folder ? keyLabel(folder.split(/[\\/]/).filter(Boolean).pop() ?? folder, 24) : "Claude");
		const recent = launched.get(key.id);

		if (recent && Date.now() - recent < CONFIRM_MS) {
			const session = runtime.store.list().find((s) => folder && s.cwd && folder.endsWith(s.project));

			await key.setImage(
				tile({
					tone: session ? "idle" : "working",
					eyebrow: session ? "running" : "starting",
					glyph: session ? "✓" : "▸",
					title: caption,
					subtitle: session ? session.status : "terminal opening",
				}),
			);
			return;
		}

		launched.delete(key.id);
		await key.setImage(
			tile({
				tone: "accent",
				eyebrow: settings.resume ? "resume" : "launch",
				glyph: "▸",
				title: caption,
				subtitle: folder ? (settings.model || "default model") : "set a folder",
			}),
		);
	}

	override async onKeyDown(ev: KeyDownEvent<LaunchSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const cwd = settings.cwd || runtime.settings.defaultCwd;

		if (!cwd?.trim()) {
			await this.refuse(ev.action, "Set a folder first");
			return;
		}

		const error = await launchClaude({
			location: await runtime.location(),
			cwd: cwd.trim(),
			resume: settings.resume,
			model: settings.model || undefined,
			permissionMode: settings.permissionMode || undefined,
			prompt: settings.prompt || undefined,
		});

		if (error) {
			await this.refuse(ev.action, "Could not open a terminal");
			return;
		}

		launched.set(ev.action.id, Date.now());
		await ev.action.showOk();
		this.repaint();
	}
}
