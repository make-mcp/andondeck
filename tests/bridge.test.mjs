import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Bridge } from "../.test-build/bridge/server.js";

const TOKEN = "test-token";
const SESSION = "session-under-test";

/** Posts a hook payload the way Claude Code would and returns the decision. */
async function hook(port, body) {
	const response = await fetch(`http://127.0.0.1:${port}/hook`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-claude-deck-token": TOKEN },
		body: JSON.stringify({ session_id: SESSION, cwd: "/home/dev/acme-api", ...body }),
	});

	assert.equal(response.status, 200, "hooks must always get a 200 back");
	return response.json();
}

describe("bridge", () => {
	let bridge;
	let port;

	before(async () => {
		// Port 0 lets the OS pick a free one, so the suite never collides with a running plugin.
		bridge = new Bridge({ port: 0, exposeToWsl: false, token: TOKEN, deckApprovals: true, approvalTimeoutMs: 2000 });
		await bridge.start();
		port = bridge.address.port;
	});

	after(async () => {
		await bridge.stop();
	});

	it("rejects hooks without the token", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/hook`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart" }),
		});

		assert.equal(response.status, 401);
	});

	it("tracks a session through a turn", async () => {
		await hook(port, { hook_event_name: "SessionStart", source: "startup" });
		assert.equal(bridge.store.resolve()?.project, "acme-api");
		assert.equal(bridge.store.resolve()?.status, "idle");

		await hook(port, { hook_event_name: "UserPromptSubmit", prompt: "fix the failing test" });
		assert.equal(bridge.store.resolve()?.status, "working");

		await hook(port, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } });
		assert.equal(bridge.store.resolve()?.currentTool, "Bash");

		await hook(port, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_output: {} });
		assert.equal(bridge.store.resolve()?.usage.toolCalls, 1);
	});

	it("feeds a queued prompt back into the turn on Stop", async () => {
		bridge.store.enqueue("now update the changelog");

		const decision = await hook(port, { hook_event_name: "Stop", last_assistant_message: "done", turn_number: 1 });

		assert.equal(decision.decision, "block", "Stop must be blocked so Claude keeps going");
		assert.equal(decision.reason, "now update the changelog");
		assert.equal(bridge.store.resolve()?.status, "working");
		assert.equal(bridge.store.queueFor().length, 0);
	});

	it("lets the turn end when the queue is empty", async () => {
		const decision = await hook(port, { hook_event_name: "Stop", last_assistant_message: "all done", turn_number: 2 });

		assert.deepEqual(decision, {});
		assert.equal(bridge.store.resolve()?.status, "idle");
	});

	it("answers a permission request from the deck", async () => {
		const pending = hook(port, {
			hook_event_name: "PermissionRequest",
			tool_name: "Bash",
			tool_use_id: "toolu_1",
			tool_input: { command: "rm -rf build" },
		});

		// Give the bridge a moment to park the request before answering it.
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.equal(bridge.store.resolve()?.status, "waiting");
		assert.equal(bridge.store.firstPending()?.pending.summary, "Bash: rm -rf build");
		assert.equal(bridge.decide("toolu_1", "deny", "not from the deck"), true);

		const decision = await pending;
		assert.equal(decision.hookSpecificOutput.decision.behavior, "deny");
		assert.equal(bridge.store.resolve()?.pending, undefined);
	});

	it("falls through to the terminal when nobody answers in time", async () => {
		const decision = await hook(port, {
			hook_event_name: "PermissionRequest",
			tool_name: "Write",
			tool_use_id: "toolu_2",
			tool_input: { file_path: "/tmp/x" },
		});

		assert.deepEqual(decision, {}, "an unanswered request must not decide anything");
	});

	it("wakes an idle session through the long-poll", async () => {
		await hook(port, { hook_event_name: "Stop", last_assistant_message: "idle now", turn_number: 3 });
		assert.equal(bridge.store.resolve()?.status, "idle");

		const waiting = fetch(`http://127.0.0.1:${port}/wait`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-claude-deck-token": TOKEN },
			body: JSON.stringify({ session_id: SESSION }),
		}).then((r) => r.json());

		await new Promise((resolve) => setTimeout(resolve, 50));
		bridge.store.enqueue("and now deploy");

		const { text } = await waiting;
		assert.equal(text, "and now deploy");
		assert.equal(bridge.store.resolve()?.status, "working");
	});

	it("drops the session when it ends", async () => {
		await hook(port, { hook_event_name: "SessionEnd", reason: "clear" });
		assert.equal(bridge.store.list().length, 0);
	});
});
