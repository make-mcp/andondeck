import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";

import { SessionStore } from "./store.js";
import { summarizeTool } from "./summarize.js";
import { readTranscriptUsage } from "../claude/transcript.js";
import { READ_ONLY_TOOLS } from "./types.js";
import type {
	AutoApprove,
	AutoApproveMode,
	HookInput,
	HookOutput,
	LimitWindow,
	PendingPermission,
	PlanLimits,
	SessionState,
} from "./types.js";

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
	/** Ask the terminal to raise a notification when Claude needs attention. */
	notifyTerminal: boolean;
};

/**
 * Terminal notification escape, understood by Windows Terminal, iTerm2, ConEmu
 * and others. Claude Code only forwards a small allow-list of sequences, and
 * OSC 9 is on it.
 */
function terminalNotice(message: string): string {
	return `\u001b]9;${message.replace(/[\u0000-\u001f]/g, " ").slice(0, 120)}\u0007`;
}

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
	/** A fresh plan-limit reading from the status line. */
	limits: [PlanLimits];
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

	#autoApprove: AutoApprove = { mode: "off", until: 0 };

	/** Latest plan limits from the status line tee; `undefined` until one arrives. */
	public planLimits: PlanLimits | undefined;

	#statusSeen = false;

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

	/** How much the deck is approving on the user's behalf right now. */
	public get autoApprove(): AutoApprove {
		if (this.#autoApprove.mode !== "off" && this.#autoApprove.until > 0 && Date.now() > this.#autoApprove.until) {
			this.#autoApprove = { mode: "off", until: 0 };
			this.emit("change");
		}

		return this.#autoApprove;
	}

	/**
	 * Arms or disarms auto-approval.
	 *
	 * Always time-limited, and surfaced on the key that armed it, so it cannot
	 * be left on by accident the way a permission mode can.
	 * @param mode What to approve.
	 * @param durationMs How long it stays armed; 0 means until it is turned off.
	 */
	public setAutoApprove(mode: AutoApproveMode, durationMs: number): void {
		this.#autoApprove = { mode, until: mode === "off" || durationMs <= 0 ? 0 : Date.now() + durationMs };
		this.emit("log", `auto-approve ${mode}${this.#autoApprove.until ? ` for ${Math.round(durationMs / 1000)}s` : ""}`);
		this.emit("change");
	}

	/** Whether a tool call falls within the armed auto-approval. */
	#shouldAutoApprove(toolName: string): boolean {
		const { mode } = this.autoApprove;
		if (mode === "all") {
			return true;
		}

		return mode === "safe" && (READ_ONLY_TOOLS as readonly string[]).includes(toolName);
	}

	/**
	 * Pulls the emergency brake on a session.
	 *
	 * There is no hook that interrupts a turn in flight, but denying every tool
	 * call stops the agent from doing anything further and makes it wind down,
	 * which is the closest thing to an abort the deck can offer.
	 * @param session Session to halt.
	 */
	public halt(session: SessionState): void {
		session.haltedAt = Date.now();
		session.haltedCalls = 0;
		this.emit("log", `halt armed for ${session.project}`);
		this.store.touch();
	}

	public resume(session: SessionState): void {
		session.haltedAt = undefined;
		session.haltedCalls = 0;
		this.store.touch();
	}

	/** Answers an open permission request. */
	/**
	 * Answers an open permission request.
	 * @param behavior `always` allows and also stores a permanent rule, the same
	 * one Claude Code offers as "Yes, and don't ask again".
	 */
	public decide(toolUseId: string, behavior: "allow" | "deny" | "always", reason?: string): boolean {
		const waiter = this.#awaiting.get(toolUseId);
		if (!waiter) {
			return false;
		}

		const pending = this.store.list().find((session) => session.pending?.toolUseId === toolUseId)?.pending;

		clearTimeout(waiter.timer);
		this.#awaiting.delete(toolUseId);
		waiter.resolve({
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision:
					behavior === "deny"
						? { behavior: "deny", message: reason ?? "Denied from Stream Deck" }
						: behavior === "always" && pending
							? { behavior: "allow", updatedPermissions: permanentRule(pending) }
							: { behavior: "allow" },
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

		if (req.method !== "POST" || !["/hook", "/wait", "/status"].includes(url.pathname)) {
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

		if (url.pathname === "/status") {
			this.#onStatusLine(input as unknown as Record<string, unknown>);
			this.#json(res, 200, {});
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
				const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
				session.currentTool = toolName || undefined;

				if (session.haltedAt) {
					session.haltedCalls += 1;
					this.emit("change");
					return {
						hookSpecificOutput: {
							hookEventName: "PreToolUse",
							permissionDecision: "deny",
							permissionDecisionReason:
								"Stopped from the Stream Deck. Do not run further tools; summarise where you got to and wait.",
						},
					};
				}

				if (this.#shouldAutoApprove(toolName)) {
					this.emit("change");
					return {
						hookSpecificOutput: {
							hookEventName: "PreToolUse",
							permissionDecision: "allow",
							permissionDecisionReason: "Auto-approved from the Stream Deck",
						},
					};
				}
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
				this.emit("change");
				return this.#options.notifyTerminal
					? { terminalSequence: terminalNotice(`Claude failed: ${session.lastError}`) }
					: {};
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

		// MCP tools and anything PreToolUse did not cover still land here.
		if (this.#shouldAutoApprove(toolName)) {
			return {
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: { behavior: "allow" },
				},
			};
		}

		const pending: PendingPermission = {
			toolUseId,
			toolName,
			toolInput,
			summary: summarizeTool(toolName, toolInput),
			rule: typeof input.permission_rule === "string" ? input.permission_rule : undefined,
			suggestions: Array.isArray(input.permission_suggestions) ? input.permission_suggestions : undefined,
			receivedAt: Date.now(),
			expiresAt: Date.now() + this.#options.approvalTimeoutMs,
		};

		session.status = "waiting";
		this.store.setPending(session, pending);
		this.emit("notify", { title: "Permission needed", body: pending.summary, session });

		if (!this.#options.deckApprovals) {
			// Observe only: Claude Code shows its own prompt in the terminal.
			this.emit("change");
			return this.#options.notifyTerminal ? { terminalSequence: terminalNotice(`Claude needs permission: ${pending.summary}`) } : {};
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

	/**
	 * Takes in Claude Code's status line snapshot.
	 *
	 * It is the only place plan limits appear, and it also carries the exact
	 * context window size, which beats guessing it from the model name.
	 */
	#onStatusLine(input: Record<string, unknown>): void {
		const limits = parsePlanLimits(input.rate_limits);
		if (limits) {
			if (!this.planLimits) {
				this.emit("log", `plan limits: 5h ${limits.fiveHour?.usedPercent ?? "—"}%, week ${limits.sevenDay?.usedPercent ?? "—"}%`);
			}
			this.planLimits = limits;
			this.emit("limits", limits);
		} else if (!this.#statusSeen) {
			this.emit("log", "status line connected (no plan limits reported — API key or first response pending)");
		}
		this.#statusSeen = true;

		const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
		const workspace = input.workspace as { current_dir?: string; project_dir?: string } | undefined;
		const cwd = typeof input.cwd === "string" ? input.cwd : workspace?.project_dir ?? workspace?.current_dir;
		// The status line runs from the first moment a session is open, so it also
		// introduces sessions the deck has not heard a hook from yet — after a
		// plugin restart, for example.
		const session = sessionId ? (this.store.get(sessionId) ?? this.store.upsert(sessionId, cwd)) : undefined;

		const model = input.model as { id?: string; display_name?: string } | undefined;
		if (session && typeof model?.id === "string" && model.id) {
			session.model = model.id;
		}
		if (session && !session.transcriptPath && typeof input.transcript_path === "string") {
			session.transcriptPath = input.transcript_path;
		}
		const context = input.context_window as
			| { context_window_size?: number; current_usage?: Record<string, number> | null }
			| undefined;

		if (session && context) {
			if (typeof context.context_window_size === "number") {
				session.usage.contextWindow = context.context_window_size;
			}
			const usage = context.current_usage;
			if (usage) {
				session.usage.contextTokens =
					(usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
			}
		}

		this.store.touch();
	}

	async #onStop(session: SessionState, input: HookInput): Promise<HookOutput> {
		session.turnNumber = typeof input.turn_number === "number" ? input.turn_number : session.turnNumber + 1;
		session.lastAssistantMessage = typeof input.last_assistant_message === "string" ? input.last_assistant_message : undefined;
		session.currentTool = undefined;
		session.usage.turns += 1;

		// The brake is per-turn: once Claude has wound down, let it work again.
		if (session.haltedAt) {
			this.resume(session);
		}

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

/**
 * The permanent rule to store for an "always allow".
 *
 * Claude Code's own suggestions win: they are exactly what its terminal prompt
 * would save, including the narrowed Bash prefix or directory grant. Without
 * them, a rule for the tool is written to the project's local settings — for
 * Bash the exact command, never the whole tool, so one "always" cannot turn
 * into permission to run anything.
 */
export function permanentRule(pending: PendingPermission): unknown[] {
	if (pending.suggestions?.length) {
		return pending.suggestions;
	}

	const command = pending.toolInput.command;
	const rule =
		pending.toolName === "Bash"
			? typeof command === "string" && command.trim()
				? { toolName: "Bash", ruleContent: command.trim() }
				: undefined
			: { toolName: pending.toolName };

	return rule ? [{ type: "addRules", rules: [rule], behavior: "allow", destination: "localSettings" }] : [];
}

/**
 * Reads `rate_limits` from a status line snapshot.
 * @returns The limits, or `undefined` when none were reported (API-key users).
 */
export function parsePlanLimits(raw: unknown): PlanLimits | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}

	const window = (value: unknown): LimitWindow | undefined => {
		const entry = value as { used_percentage?: unknown; resets_at?: unknown } | undefined;
		if (typeof entry?.used_percentage !== "number" || typeof entry.resets_at !== "number") {
			return undefined;
		}
		return { usedPercent: entry.used_percentage, resetsAt: entry.resets_at * 1000 };
	};

	const source = raw as Record<string, unknown>;
	const limits: PlanLimits = { fiveHour: window(source.five_hour), sevenDay: window(source.seven_day), updatedAt: Date.now() };
	return limits.fiveHour || limits.sevenDay ? limits : undefined;
}
