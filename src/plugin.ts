import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { ApproveAction } from "./actions/approve.js";
import { AutopilotAction } from "./actions/autopilot.js";
import { HaltAction } from "./actions/halt.js";
import { LaunchAction } from "./actions/launch.js";
import { ModelAction } from "./actions/model.js";
import { HeadlessAction } from "./actions/headless.js";
import { PromptAction, PRESETS } from "./actions/prompt.js";
import { QueueControlAction } from "./actions/queue-control.js";
import { QueuePromptAction } from "./actions/queue.js";
import { SessionAction } from "./actions/session.js";
import { SlotAction } from "./actions/slot.js";
import { SetupAction } from "./actions/setup.js";
import { StatusAction } from "./actions/status.js";
import { UsageAction } from "./actions/usage.js";
import { runtime } from "./runtime.js";

streamDeck.logger.setLevel("debug");

// A key press that throws must leave a trace; the SDK does not report one.
process.on("unhandledRejection", (reason) => {
	streamDeck.logger.error(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
process.on("uncaughtException", (error) => {
	streamDeck.logger.error(`uncaught exception: ${error.stack ?? error.message}`);
});

streamDeck.actions.onKeyDown((ev) => {
	streamDeck.logger.info(`keyDown ${ev.action.manifestId} settings=${JSON.stringify(ev.payload.settings)}`);
});

streamDeck.actions.onWillAppear((ev) => {
	streamDeck.logger.info(`willAppear ${ev.action.manifestId}`);
});

streamDeck.actions.registerAction(new StatusAction());
streamDeck.actions.registerAction(new QueuePromptAction());
streamDeck.actions.registerAction(new QueueControlAction());
streamDeck.actions.registerAction(new ApproveAction());
streamDeck.actions.registerAction(new PromptAction());
streamDeck.actions.registerAction(new SessionAction());
streamDeck.actions.registerAction(new HeadlessAction());
streamDeck.actions.registerAction(new UsageAction());
streamDeck.actions.registerAction(new AutopilotAction());
streamDeck.actions.registerAction(new HaltAction());
streamDeck.actions.registerAction(new ModelAction());
streamDeck.actions.registerAction(new SlotAction());
streamDeck.actions.registerAction(new LaunchAction());
streamDeck.actions.registerAction(new SetupAction());

/**
 * Serves the dropdown data every property inspector shares.
 *
 * `sdpi-components` asks for a data source by sending its `event` name here and
 * expects the same name back alongside the items.
 */
streamDeck.ui.onSendToPlugin(async (ev) => {
	const payload = ev.payload as { event?: string };

	switch (payload?.event) {
		case "getSessions": {
			await streamDeck.ui.sendToPropertyInspector({
				event: "getSessions",
				items: [
					{ label: "Active session (follow)", value: "" },
					...runtime.store.summaries().map((session) => ({
						label: `${session.project} · ${session.status}`,
						value: `id:${session.sessionId}`,
					})),
				],
			} as JsonValue);
			break;
		}

		case "getPresets": {
			await streamDeck.ui.sendToPropertyInspector({
				event: "getPresets",
				items: PRESETS.map((preset) => ({ label: preset.label, value: preset.id })),
			} as JsonValue);
			break;
		}

		case "getDistros": {
			const diagnostics = await runtime.diagnostics();
			await streamDeck.ui.sendToPropertyInspector({
				event: "getDistros",
				items: [
					{ label: "Default", value: "" },
					...((diagnostics.distros as string[]) ?? []).map((name) => ({ label: name, value: name })),
				],
			} as JsonValue);
			break;
		}

		default:
			break;
	}
});

// Surface bridge notifications in the plugin log; the keys themselves repaint.
runtime.on("notify", ({ title, body }) => streamDeck.logger.info(`${title}: ${body}`));

// One line per press, so a key that "does nothing" can be told apart from a
// key whose press never arrived.
const short = (uuid: string) => uuid.replace("io.github.claude-deck.plugin.", "");
streamDeck.actions.onKeyDown((ev) => streamDeck.logger.info(`press ${short(ev.action.manifestId)} ${JSON.stringify(ev.payload.settings)}`));
streamDeck.actions.onDialDown((ev) => streamDeck.logger.info(`dial press ${short(ev.action.manifestId)}`));
streamDeck.actions.onDialRotate((ev) => streamDeck.logger.info(`dial turn ${short(ev.action.manifestId)} ${ev.payload.ticks}`));

await streamDeck.connect();
await runtime.start();
