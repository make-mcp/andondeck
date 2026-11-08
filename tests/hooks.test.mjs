import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { hooksInstalled, installHooks, uninstallHooks } from "../.test-build/claude/hooks.js";

async function scratch() {
	const dir = await mkdtemp(join(tmpdir(), "claude-deck-"));
	return {
		dir,
		settingsPath: join(dir, "settings.json"),
		options: (overrides = {}) => ({
			baseUrl: "http://127.0.0.1:38274",
			token: "token-123",
			approvalTimeoutSec: 45,
			deckApprovals: true,
			idleWake: false,
			location: {
				kind: "native",
				settingsPath: join(dir, "settings.json"),
				dataDir: join(dir, "claude-deck"),
				dataDirForClaude: join(dir, "claude-deck"),
			},
			...overrides,
		}),
	};
}

describe("hook installation", () => {
	it("writes hooks Claude Code can act on", async () => {
		const { settingsPath, options } = await scratch();
		await installHooks(options());

		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		const stop = settings.hooks.Stop[0].hooks[0];

		assert.equal(stop.type, "http");
		assert.equal(stop.url, "http://127.0.0.1:38274/hook");
		assert.equal(stop.headers["X-Claude-Deck-Token"], "token-123");
		assert.equal(stop.onFailure, "continue", "a closed Stream Deck must never block Claude");
		assert.deepEqual(stop.allowedEnvVars, ["WSL_DISTRO_NAME"]);
		assert.ok(settings.hooks.PermissionRequest, "deck approvals need the PermissionRequest hook");
		assert.equal(await hooksInstalled(settingsPath), true);
	});

	it("leaves hooks owned by someone else alone", async () => {
		const { settingsPath, options } = await scratch();
		await writeFile(
			settingsPath,
			JSON.stringify({
				model: "opus",
				hooks: {
					Stop: [{ hooks: [{ type: "command", command: "./notify.sh" }] }],
					PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] }],
				},
			}),
			"utf8",
		);

		await installHooks(options());
		await uninstallHooks(settingsPath);

		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.equal(settings.model, "opus", "unrelated settings must survive");
		assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: "command", command: "./notify.sh" }] }]);
		assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] }]);
		assert.equal(await hooksInstalled(settingsPath), false);
	});

	it("installs twice without duplicating itself", async () => {
		const { settingsPath, options } = await scratch();
		await installHooks(options());
		await installHooks(options());

		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.equal(settings.hooks.Stop[0].hooks.length, 1);
		assert.equal(settings.hooks.SessionStart.length, 1);
	});

	it("generates the idle-wake helper next to the settings", async () => {
		const { dir, settingsPath, options } = await scratch();
		await installHooks(options({ idleWake: true }));

		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		const wake = settings.hooks.Stop[0].hooks.find((hook) => hook.type === "command");

		assert.ok(wake, "idle wake needs a command hook");
		assert.equal(wake.async, true);
		assert.equal(wake.asyncRewake, true);

		const script = await readFile(join(dir, "claude-deck", "idle-wake.mjs"), "utf8");
		assert.match(script, /process\.exit\(2\)/, "waking Claude relies on exit code 2");
		assert.match(script, /token-123/);
	});
});
