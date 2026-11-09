import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Bridge, parsePlanLimits, permanentRule } from "../.test-build/bridge/server.js";
import { installHooks, setAutoCompactWindow, statusLineInstalled, uninstallHooks } from "../.test-build/claude/hooks.js";

const TOKEN = "token-features";

async function scratch(baseUrl = "http://127.0.0.1:38274") {
	const dir = await mkdtemp(join(tmpdir(), "claude-deck-"));
	const location = {
		kind: "native",
		settingsPath: join(dir, "settings.json"),
		dataDir: join(dir, "claude-deck"),
		dataDirForClaude: join(dir, "claude-deck"),
	};
	return {
		dir,
		location,
		settingsPath: location.settingsPath,
		options: (overrides = {}) => ({
			baseUrl,
			token: TOKEN,
			approvalTimeoutSec: 45,
			deckApprovals: true,
			idleWake: false,
			planLimits: true,
			location,
			...overrides,
		}),
	};
}

describe("always allow", () => {
	it("passes Claude Code's own suggestion back unchanged", () => {
		const suggestion = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" };
		assert.deepEqual(permanentRule({ toolName: "Bash", toolInput: { command: "npm test" }, suggestions: [suggestion] }), [suggestion]);
	});

	it("falls back to the exact Bash command, never the whole tool", () => {
		const [update] = permanentRule({ toolName: "Bash", toolInput: { command: "rm -rf build" } });
		assert.deepEqual(update.rules, [{ toolName: "Bash", ruleContent: "rm -rf build" }]);
		assert.equal(update.destination, "localSettings");
	});

	it("stores nothing for a Bash call without a command", () => {
		assert.deepEqual(permanentRule({ toolName: "Bash", toolInput: {} }), []);
	});
});

describe("plan limits", () => {
	it("reads both windows and converts reset times to milliseconds", () => {
		const limits = parsePlanLimits({
			five_hour: { used_percentage: 42.5, resets_at: 1_900_000_000 },
			seven_day: { used_percentage: 12, resets_at: 1_900_500_000 },
		});
		assert.equal(limits.fiveHour.usedPercent, 42.5);
		assert.equal(limits.fiveHour.resetsAt, 1_900_000_000_000);
		assert.equal(limits.sevenDay.usedPercent, 12);
	});

	it("reports nothing for API-key users", () => {
		assert.equal(parsePlanLimits(undefined), undefined);
		assert.equal(parsePlanLimits({ spend_limit: { used_percentage: 1, resets_at: 1 } }), undefined);
	});
});

describe("auto-compact window", () => {
	it("writes Claude Code's setting, clamped to its accepted range", async () => {
		const { settingsPath } = await scratch();
		await writeFile(settingsPath, JSON.stringify({ model: "opus" }), "utf8");

		assert.equal(await setAutoCompactWindow(settingsPath, 50_000), 100_000);
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.equal(settings.autoCompactWindow, 100_000);
		assert.equal(settings.model, "opus", "other settings survive");
	});
});

describe("status line relay", () => {
	let bridge;
	let port;

	before(async () => {
		bridge = new Bridge({ port: 0, exposeToWsl: false, token: TOKEN, deckApprovals: true, approvalTimeoutMs: 2000, notifyTerminal: false });
		await bridge.start();
		port = bridge.address.port;
	});

	after(async () => {
		await bridge.stop();
	});

	it("chains the user's status line, feeds the bridge, and restores it on removal", { skip: process.platform === "win32" }, async () => {
		const { settingsPath, location, options } = await scratch(`http://127.0.0.1:${port}`);
		const mine = { type: "command", command: "jq -r '\"mine:\" + .model.display_name' 2>/dev/null || echo mine", padding: 1 };
		await writeFile(settingsPath, JSON.stringify({ statusLine: mine }), "utf8");

		await installHooks(options());
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.match(settings.statusLine.command, /deck-statusline\.sh/);
		assert.equal(settings.statusLine.padding, 1, "the user's padding is kept");
		assert.equal(await statusLineInstalled(settingsPath), true);

		// Run the generated relay exactly the way Claude Code would.
		const snapshot = {
			session_id: "s1",
			model: { display_name: "Opus" },
			rate_limits: { five_hour: { used_percentage: 61, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
		};
		const output = execFileSync("sh", ["-c", settings.statusLine.command], { input: JSON.stringify(snapshot), encoding: "utf8" });
		assert.match(output, /mine/, "the user's own status line still prints");

		for (let i = 0; i < 40 && !bridge.planLimits; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(bridge.planLimits?.fiveHour?.usedPercent, 61);

		// Re-installing must not record the relay as the "original".
		await installHooks(options());
		await uninstallHooks(settingsPath, location);
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).statusLine, mine);
	});

	it("learns a session and its model from the status line alone", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/status`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-claude-deck-token": TOKEN },
			body: JSON.stringify({ session_id: "fresh", cwd: "/work/app", model: { id: "claude-opus-5-5", display_name: "Opus" } }),
		});
		assert.equal(response.status, 200);
		const session = bridge.store.get("fresh");
		assert.equal(session?.model, "claude-opus-5-5");
		assert.equal(session?.project, "app");
	});

	it("removes the slot again when there was no status line before", async () => {
		const { settingsPath, location, options } = await scratch(`http://127.0.0.1:${port}`);
		await installHooks(options());
		await uninstallHooks(settingsPath, location);
		assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).statusLine, undefined);
	});
});
