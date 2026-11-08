import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";

import { SessionStore } from "./store.js";
import { summarizeTool } from "./summarize.js";
import { readTranscriptUsage } from "../claude/transcript.js";
import type { HookInput, HookOutput, PendingPermission, SessionState } from "./types.js";

/** Largest hook payload the bridge will read, to keep a runaway transcript from eating memory. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type BridgeOptions = {
	port: number;
	/** Bind on all interfaces so Claude Code inside WSL can reach the Windows host. */
	exposeToWsl: boolean;
	token: string;
	/** Hold permission requests open so they can be answered from the deck. */
	deckApprovals: boolean;
	approvalTimeoutMs: number;
};

type PendingResolver = {
	resolve: (output: HookOutput) => void;
	timer: NodeJS.Timeout;
};

/** A parked `/wait` long-poll belonging to an idle session. */
type IdleWaiter = {
	finish: (text: string | undefined) => void;
	timer: NodeJS.Timeout;
	poll: NodeJS.Timeout;
};

/** How long an idle-wake long-poll is held before the hook is told to give up. */
const IDLE_WAIT_MS = 9 * 60 * 1000;

/** Consecutive ports tried before giving up on binding. */
const PORT_ATTEMPTS = 10;

export type BridgeEvents = {
	change: [];
	notify: [{ title: string; body: string; session: SessionState }];
	log: [string];
};

/**
 * Local HTTP endpoint Claude Code's hooks talk to.
 *
 * Every hook event lands on `POST /hook`; the JSON this returns becomes the
 * hook's decision, which is how queued prompts re-enter a finished turn and how
 * permission requests get answered from a key.
 */
export class Bridge extends EventEmitter<BridgeEvents> {
	readonly store = new SessionStore();

	#server: Server | undefined;
	#options: BridgeOptions;
	#listening = false;
	#lastError: string | undefined;

	/** Open permission requests, keyed by `tool_use_id`. */
	readonly #awaiting = new Map<string, PendingResolver>();

	/** Parked idle-wake long-polls, at most one per session. */
	readonly #idleWaiters = new Map<string, IdleWaiter>();

	public constructor(options: BridgeOptions) {
		super();
		this.#options = options;
		this.store.on("change", () => this.emit("change"));
	}

	public get listening(): boolean {
		return this.#listening;
	}

	public get lastError(): string | undefined {
		return this.#lastError;
	}

	/** The socket the bridge actually bound to; useful when the port was left to the OS. */
	public get address(): { address: string; port: number } | undefined {
		const info = this.#server?.address();
		return info && typeof info !== "string" ? { address: info.address, port: info.port } : undefined;
	}

	public get options(): Readonly<BridgeOptions> {
		return this.#options;
	}

	/** Applies new options, restarting the listener only when the socket itself changed. */
	public async configure(options: BridgeOptions): Promise<void> {
		const needsRestart =
			options.port !== this.#options.port || options.exposeToWsl !== this.#options.exposeToWsl;
		this.#options = options;

		if (needsRestart) {
			await this.stop();
			await this.start();
		}
	}

	/**
	 * Binds the bridge, walking forward a few ports if the configured one is taken.
	 *
	 * Another plugin, a dev instance or an unrelated service can hold the default
	 * port; falling forward keeps the plugin usable, and the caller persists
	 * whichever port actually won so the hooks can be pointed at it.
	 */
	public async start(): Promise<void> {
		if (this.#server) {
			return;
		}

		const host = this.#options.exposeToWsl ? "0.0.0.0" : "127.0.0.1";

		for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
			const port = this.#options.port + attempt;
			const bound = await this.#listen(host, port);

			if (bound) {
				this.#options = { ...this.#options, port };
				this.#listening = true;
				this.#lastError = undefined;
				this.emit("log", `bridge listening on ${host}:${port}`);
				this.emit("change");
				return;
			}
		}

		this.#listening = false;
		this.#lastError = `Ports ${this.#options.port}-${this.#options.port + PORT_ATTEMPTS - 1} are all in use. Pick another port in the Connect Claude Code action.`;
		this.emit("change");
	}

	/** Attempts a single bind; resolves false when the port is unavailable. */
	#listen(host: string, port: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const server = createServer((req, res) => void this.#handle(req, res));

			const onError = (error: NodeJS.ErrnoException): void => {
				server.close();
				if (error.code !== "EADDRINUSE" && error.code !== "EACCES") {
					this.#lastError = error.message;
				}
				resolve(false);
			};

			server.once("error", onError);
			server.listen(port, host, () => {
				server.removeListener("error", onError);
				server.on("error", (error) => this.emit("log", `bridge error: ${error.message}`));
				this.#server = server;
				resolve(true);
			});
		});
	}

	public async stop(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		this.#listening = false;

		for (const [id, waiter] of this.#awaiting) {
			clearTimeout(waiter.timer);
			waiter.resolve({});
			this.#awaiting.delete(id);
		}

		for (const sessionId of [...this.#idleWaiters.keys()]) {
			this.#cancelIdleWaiter(sessionId);
		}

		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	/** Answers an open permission request. */
	public decide(toolUseId: string, behavior: "allow" | "deny", reason?: string): boolean {
		const waiter = this.#awaiting.get(toolUseId);
		if (!waiter) {
			return false;
		}

		clearTimeout(waiter.timer);
		this.#awaiting.delete(toolUseId);
		waiter.resolve({
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: reason ?? "Denied from Stream Deck" },
			},
		});

		for (const session of this.store.list()) {
			if (session.pending?.toolUseId === toolUseId) {
				this.store.setPending(session, undefined);
				this.store.setStatus(session, "working");
			}
		}

		return true;
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");

		if (req.method === "GET" && url.pathname === "/health") {
			this.#json(res, 200, { ok: true, sessions: this.store.summaries().length, version: 1 });
			return;
		}

		if (req.method !== "POST" || (url.pathname !== "/hook" && url.pathname !== "/wait")) {
			this.#json(res, 404, { error: "not found" });
			return;
		}

		const token = req.headers["x-claude-deck-token"] ?? url.searchParams.get("token") ?? "";
		if (this.#options.token && token !== this.#options.token) {
			this.#json(res, 401, { error: "bad token" });
			return;
		}

		let input: HookInput;
		try {
			input = JSON.parse(await this.#readBody(req)) as HookInput;
		} catch (error) {
			this.#json(res, 400, { error: (error as Error).message });
			return;
		}

		if (url.pathname === "/wait") {
			const text = await this.#waitForIdlePrompt(String(input.session_id ?? ""));
			this.#json(res, 200, { text: text ?? null });
			return;
		}

		const distro = typeof req.headers["x-claude-deck-distro"] === "string" ? req.headers["x-claude-deck-distro"] : undefined;

		try {
			const output = await this.#onHook(input, distro);
			this.#json(res, 200, output);
		} catch (error) {
			this.emit("log", `hook ${input.hook_event_name} failed: ${(error as Error).message}`);
			this.#json(res, 200, {});
		}
	}

	async #onHook(input: HookInput, distro?: string): Promise<HookOutput> {
		if (!input.session_id) {
			return {};
		}

		const session = this.store.upsert(input.session_id, input.cwd);
		if (distro && distro !== "$WSL_DISTRO_NAME") {
			session.wslDistro = distro;
		}
		if (input.permission_mode) {
			session.permissionMode = input.permission_mode;
		}
		if (typeof input.transcript_path === "string") {
			session.transcriptPath = input.transcript_path;
		}

		// Subagent events describe a child, not the session the deck watches.
		if (input.agent_id && input.hook_event_name !== "SubagentStart" && input.hook_event_name !== "SubagentStop") {
			this.emit("change");
			return {};
		}

		switch (input.hook_event_name) {
			case "SessionStart": {
				session.status = "idle";
				session.startedAt = Date.now();
				break;
			}

			case "UserPromptSubmit": {
				this.#cancelIdleWaiter(session.sessionId);
				session.status = "working";
				session.turnStartedAt = Date.now();
				session.lastPrompt = typeof input.prompt === "string" ? input.prompt : undefined;
				session.lastError = undefined;
				break;
			}

			case "PreToolUse": {
				session.status = "working";
				session.currentTool = typeof input.tool_name === "string" ? input.tool_name : undefined;
				break;
			}

			case "PostToolUse":
			case "PostToolUseFailure": {
				session.usage.toolCalls += 1;
				session.currentTool = undefined;
				break;
			}

			case "PermissionRequest": {
				return this.#onPermissionRequest(session, input);
			}

			case "PermissionDenied": {
				session.lastError = `Denied: ${String(input.tool_name ?? "tool")}`;
				break;
			}

			case "PreCompact": {
				session.status = "compacting";
				break;
			}

			case "PostCompact": {
				session.status = "working";
				break;
			}

			case "PostModelSwitch": {
				session.model = typeof input.to_model === "string" ? input.to_model : session.model;
				break;
			}

			case "SubagentStart": {
				session.subagents += 1;
				break;
			}

			case "SubagentStop": {
				session.subagents = Math.max(0, session.subagents - 1);
				break;
			}

			case "Notification": {
				return this.#onNotification(session, input);
			}

			case "Stop": {
				return this.#onStop(session, input);
			}

			case "StopFailure": {
				session.status = "error";
				session.lastError = typeof input.error_message === "string" ? input.error_message : String(input.error_type ?? "error");
				session.turnStartedAt = undefined;
				this.emit("notify", { title: "Claude failed", body: session.lastError, session });
				break;
			}

			case "SessionEnd": {
				this.#cancelIdleWaiter(session.sessionId);
				session.status = "ended";
				this.store.remove(session.sessionId);
				return {};
			}

			default:
				break;
		}

		this.emit("change");
		return {};
	}

	#onPermissionRequest(session: SessionState, input: HookInput): Promise<HookOutput> | HookOutput {
		const toolUseId = String(input.tool_use_id ?? `${session.sessionId}:${Date.now()}`);
		const toolName = String(input.tool_name ?? "tool");
		const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

		const pending: PendingPermission = {
			toolUseId,
			toolName,
			toolInput,
			summary: summarizeTool(toolName, toolInput),
			rule: typeof input.permission_rule === "string" ? input.permission_rule : undefined,
			receivedAt: Date.now(),
			expiresAt: Date.now() + this.#options.approvalTimeoutMs,
		};

		session.status = "waiting";
		this.store.setPending(session, pending);
		this.emit("notify", { title: "Permission needed", body: pending.summary, session });

		if (!this.#options.deckApprovals) {
			// Observe only: Claude Code shows its own prompt in the terminal.
			this.emit("change");
			return {};
		}

		return new Promise<HookOutput>((resolve) => {
			const timer = setTimeout(() => {
				this.#awaiting.delete(toolUseId);
				if (session.pending?.toolUseId === toolUseId) {
					this.store.setPending(session, undefined);
				}
				resolve({});
			}, this.#options.approvalTimeoutMs);

			// Do not keep the plugin alive just for a pending approval.
			timer.unref?.();
			this.#awaiting.set(toolUseId, { resolve, timer });
			this.emit("change");
		});
	}

	#onNotification(session: SessionState, input: HookInput): HookOutput {
		const type = String(input.type ?? "");
		const message = String(input.message ?? "");

		if (type === "permission_prompt") {
			session.status = "waiting";
		} else if (type === "idle_prompt") {
			session.status = "idle";
			session.turnStartedAt = undefined;
		}

		if (message) {
			this.emit("notify", { title: "Claude Code", body: message, session });
		}

		this.emit("change");
		return {};
	}

	async #onStop(session: SessionState, input: HookInput): Promise<HookOutput> {
		session.turnNumber = typeof input.turn_number === "number" ? input.turn_number : session.turnNumber + 1;
		session.lastAssistantMessage = typeof input.last_assistant_message === "string" ? input.last_assistant_message : undefined;
		session.currentTool = undefined;
		session.usage.turns += 1;

		if (session.turnStartedAt) {
			session.usage.busyMs += Date.now() - session.turnStartedAt;
		}

		await this.#sampleUsage(session);

		const next = this.store.dequeue(session);
		if (next) {
			session.status = "working";
			session.turnStartedAt = Date.now();
			this.emit("log", `feeding queued prompt into ${session.project}`);
			this.emit("change");
			return { decision: "block", reason: next.text };
		}

		session.status = "idle";
		session.turnStartedAt = undefined;
		this.emit("notify", {
			title: `Claude finished · ${session.project}`,
			body: session.lastAssistantMessage?.slice(0, 160) ?? "",
			session,
		});
		this.emit("change");
		return {};
	}

	/** Best-effort token/cost sample from the transcript; silently skipped when unreadable. */
	async #sampleUsage(session: SessionState): Promise<void> {
		if (!session.transcriptPath) {
			return;
		}

		const sample = await readTranscriptUsage(session.transcriptPath, session.wslDistro);
		if (!sample) {
			return;
		}

		session.usage.inputTokens += sample.inputTokens;
		session.usage.outputTokens += sample.outputTokens;
		session.usage.cacheReadTokens += sample.cacheReadTokens;
		session.usage.contextTokens = sample.contextTokens;
		session.usage.costUsd += sample.costUsd;
		session.model ??= sample.model;
	}

	/**
	 * Parks an idle-wake request until a prompt is queued for that session.
	 *
	 * The `Stop` hook can only feed a prompt back into a turn that is still
	 * running. Once a session has gone idle nothing is left to block, so an
	 * `asyncRewake` command hook long-polls here instead and exits 2 with the
	 * prompt, which wakes Claude back up.
	 * @param sessionId Session the hook belongs to.
	 * @returns The queued prompt, or `undefined` when the wait expired.
	 */
	#waitForIdlePrompt(sessionId: string): Promise<string | undefined> {
		this.#cancelIdleWaiter(sessionId);

		if (!sessionId) {
			return Promise.resolve(undefined);
		}

		return new Promise<string | undefined>((resolve) => {
			const finish = (text: string | undefined): void => {
				const waiter = this.#idleWaiters.get(sessionId);
				if (waiter) {
					clearTimeout(waiter.timer);
					clearInterval(waiter.poll);
					this.#idleWaiters.delete(sessionId);
				}
				resolve(text);
			};

			const poll = setInterval(() => {
				const session = this.store.get(sessionId);
				if (!session || session.status === "ended") {
					finish(undefined);
					return;
				}

				// Only deliver while genuinely idle; an active turn uses the Stop path.
				if (session.status !== "idle") {
					return;
				}

				const item = this.store.dequeue(session);
				if (item) {
					session.status = "working";
					session.turnStartedAt = Date.now();
					this.emit("log", `waking ${session.project} with a queued prompt`);
					this.emit("change");
					finish(item.text);
				}
			}, 500);
			poll.unref?.();

			const timer = setTimeout(() => finish(undefined), IDLE_WAIT_MS);
			timer.unref?.();

			this.#idleWaiters.set(sessionId, { finish, timer, poll });
		});
	}

	#cancelIdleWaiter(sessionId: string): void {
		this.#idleWaiters.get(sessionId)?.finish(undefined);
	}

	async #readBody(req: IncomingMessage): Promise<string> {
		const chunks: Buffer[] = [];
		let size = 0;

		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY_BYTES) {
				throw new Error("hook payload too large");
			}
			chunks.push(chunk as Buffer);
		}

		return Buffer.concat(chunks).toString("utf8");
	}

	#json(res: ServerResponse, status: number, body: unknown): void {
		const payload = JSON.stringify(body);
		res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
		res.end(payload);
	}
}
