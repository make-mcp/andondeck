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
		bridge = new Bridge({
			port: 0,
			exposeToWsl: false,
			token: TOKEN,
			deckApprovals: true,
			approvalTimeoutMs: 2000,
			notifyTerminal: false,
		});
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

describe("autopilot and the brake", () => {
	let bridge;
	let port;
	const SID = "autopilot-session";

	const post = async (body) => {
		const response = await fetch(`http://127.0.0.1:${port}/hook`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-claude-deck-token": TOKEN },
			body: JSON.stringify({ session_id: SID, cwd: "/home/dev/widget", ...body }),
		});
		return response.json();
	};

	const preToolUse = (tool_name, tool_input = {}) =>
		post({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: `t${Math.random()}` });

	before(async () => {
		bridge = new Bridge({
			port: 0,
			exposeToWsl: false,
			token: TOKEN,
			deckApprovals: true,
			approvalTimeoutMs: 1000,
			notifyTerminal: false,
		});
		await bridge.start();
		port = bridge.address.port;
		await post({ hook_event_name: "SessionStart", source: "startup" });
	});

	after(async () => {
		await bridge.stop();
	});

	it("decides nothing while disarmed", async () => {
		assert.deepEqual(await preToolUse("Read", { file_path: "/x" }), {});
		assert.deepEqual(await preToolUse("Bash", { command: "rm -rf /" }), {});
	});

	it("waves through only read-only tools on the safe setting", async () => {
		bridge.setAutoApprove("safe", 60_000);

		const read = await preToolUse("Read", { file_path: "/x" });
		assert.equal(read.hookSpecificOutput.permissionDecision, "allow");

		const bash = await preToolUse("Bash", { command: "npm test" });
		assert.deepEqual(bash, {}, "a shell command is not read-only");
	});

	it("waves through everything when armed for all tools", async () => {
		bridge.setAutoApprove("all", 60_000);

		const bash = await preToolUse("Bash", { command: "npm test" });
		assert.equal(bash.hookSpecificOutput.permissionDecision, "allow");
	});

	it("disarms itself once the window has passed", async () => {
		bridge.setAutoApprove("all", 40);
		await new Promise((resolve) => setTimeout(resolve, 80));

		assert.equal(bridge.autoApprove.mode, "off");
		assert.deepEqual(await preToolUse("Bash", { command: "npm test" }), {});
	});

	it("denies every tool call once the brake is pulled", async () => {
		const session = bridge.store.resolve();
		bridge.halt(session);

		const first = await preToolUse("Bash", { command: "npm test" });
		assert.equal(first.hookSpecificOutput.permissionDecision, "deny");
		assert.match(first.hookSpecificOutput.permissionDecisionReason, /Stream Deck/);

		await preToolUse("Read", { file_path: "/x" });
		assert.equal(bridge.store.resolve().haltedCalls, 2, "blocked calls are counted for the key");
	});

	it("outranks autopilot, so arming cannot defeat the brake", async () => {
		bridge.setAutoApprove("all", 60_000);

		const blocked = await preToolUse("Bash", { command: "npm test" });
		assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");

		bridge.setAutoApprove("off", 0);
	});

	it("releases itself when the turn ends", async () => {
		await post({ hook_event_name: "Stop", last_assistant_message: "stopped", turn_number: 1 });

		assert.equal(bridge.store.resolve().haltedAt, undefined);
		assert.deepEqual(await preToolUse("Bash", { command: "npm test" }), {});
	});
});
