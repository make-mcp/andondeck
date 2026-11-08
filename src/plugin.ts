import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { ApproveAction } from "./actions/approve.js";
import { AutopilotAction } from "./actions/autopilot.js";
import { HaltAction } from "./actions/halt.js";
import { ModelAction } from "./actions/model.js";
import { HeadlessAction } from "./actions/headless.js";
import { PromptAction, PRESETS } from "./actions/prompt.js";
import { QueueControlAction } from "./actions/queue-control.js";
import { QueuePromptAction } from "./actions/queue.js";
import { SessionAction } from "./actions/session.js";
import { SetupAction } from "./actions/setup.js";
import { StatusAction } from "./actions/status.js";
import { UsageAction } from "./actions/usage.js";
import { runtime } from "./runtime.js";

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

await streamDeck.connect();
await runtime.start();
