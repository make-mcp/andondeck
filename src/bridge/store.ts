import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";

import type {
	PendingPermission,
	QueueItem,
	SessionState,
	SessionStatus,
	SessionSummary,
} from "./types.js";

/** How long a session may stay silent before it is treated as stale. */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

function emptyUsage(): SessionState["usage"] {
	return {
		turns: 0,
		toolCalls: 0,
		busyMs: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		contextTokens: 0,
		costUsd: 0,
	};
}

/**
 * In-memory registry of every Claude Code session that has reported in, plus
 * the prompt queue and the pending permission request attached to each.
 *
 * Emits `change` whenever anything an action renders has moved.
 */
export class SessionStore extends EventEmitter {
	readonly #sessions = new Map<string, SessionState>();

	/** Queue entries added before any session was known; claimed by the next session to finish a turn. */
	readonly #orphanQueue: QueueItem[] = [];

	/** Session the user pinned explicitly; when unset the most recent one wins. */
	#pinnedSessionId: string | undefined;

	public get pinnedSessionId(): string | undefined {
		return this.#pinnedSessionId;
	}

	public set pinnedSessionId(value: string | undefined) {
		this.#pinnedSessionId = value && this.#sessions.has(value) ? value : undefined;
		this.touch();
	}

	/** Announces that something observable changed. */
	public touch(): void {
		this.emit("change");
	}

	/** Returns the live session, creating a placeholder entry the first time one reports in. */
	public upsert(sessionId: string, cwd?: string): SessionState {
		let session = this.#sessions.get(sessionId);
		if (!session) {
			session = {
				sessionId,
				cwd: cwd ?? "",
				project: cwd ? basename(cwd) : sessionId.slice(0, 8),
				status: "idle",
				turnNumber: 0,
				lastEventAt: Date.now(),
				startedAt: Date.now(),
				subagents: 0,
				queue: this.#orphanQueue.splice(0, this.#orphanQueue.length),
				haltedCalls: 0,
				usage: emptyUsage(),
			};
			this.#sessions.set(sessionId, session);
		}

		if (cwd && cwd !== session.cwd) {
			session.cwd = cwd;
			session.project = basename(cwd) || cwd;
		}

		session.lastEventAt = Date.now();
		return session;
	}

	public get(sessionId: string): SessionState | undefined {
		return this.#sessions.get(sessionId);
	}

	public remove(sessionId: string): void {
		this.#sessions.delete(sessionId);
		if (this.#pinnedSessionId === sessionId) {
			this.#pinnedSessionId = undefined;
		}
		this.touch();
	}

	/** Sessions ordered most-recently-active first, with stale ones dropped. */
	public list(): SessionState[] {
		const cutoff = Date.now() - STALE_AFTER_MS;
		for (const [id, session] of this.#sessions) {
			if (session.lastEventAt < cutoff) {
				this.#sessions.delete(id);
			}
		}

		return [...this.#sessions.values()].sort((a, b) => b.lastEventAt - a.lastEventAt);
	}

	public summaries(): SessionSummary[] {
		return this.list().map((session) => ({
			sessionId: session.sessionId,
			project: session.project,
			cwd: session.cwd,
			status: session.status,
			model: session.model,
			permissionMode: session.permissionMode,
			lastEventAt: session.lastEventAt,
			queued: session.queue.length,
		}));
	}

	/**
	 * Resolves which session a key acts on.
	 * @param selector Pinned session id, or a `project:<name>` / `cwd:<path>` binding; omit to follow the active session.
	 * @returns The matching session, or `undefined` when nothing matches.
	 */
	public resolve(selector?: string): SessionState | undefined {
		const sessions = this.list();
		if (sessions.length === 0) {
			return undefined;
		}

		if (selector?.startsWith("id:")) {
			return this.#sessions.get(selector.slice(3));
		}

		if (selector?.startsWith("project:")) {
			const needle = selector.slice(8).toLowerCase();
			return sessions.find((s) => s.project.toLowerCase() === needle);
		}

		if (selector?.startsWith("cwd:")) {
			const needle = selector.slice(4).replace(/[\\/]+$/, "").toLowerCase();
			return sessions.find((s) => s.cwd.replace(/[\\/]+$/, "").toLowerCase() === needle);
		}

		if (this.#pinnedSessionId) {
			const pinned = this.#sessions.get(this.#pinnedSessionId);
			if (pinned) {
				return pinned;
			}
		}

		// Prefer a session that actually wants something from the user.
		return sessions.find((s) => s.status === "waiting") ?? sessions.find((s) => s.status !== "ended") ?? sessions[0];
	}

	public setStatus(session: SessionState, status: SessionStatus): void {
		session.status = status;
		this.touch();
	}

	/** Adds a prompt to a session's queue, or parks it until a session appears. */
	public enqueue(text: string, selector?: string, label?: string): { queued: number; session?: SessionState } {
		const item: QueueItem = { id: randomUUID(), text, addedAt: Date.now(), label };
		const session = this.resolve(selector);
		if (session) {
			session.queue.push(item);
			this.touch();
			return { queued: session.queue.length, session };
		}

		this.#orphanQueue.push(item);
		this.touch();
		return { queued: this.#orphanQueue.length };
	}

	/** Pops the next prompt for a session, pulling in parked entries when its own queue is empty. */
	public dequeue(session: SessionState): QueueItem | undefined {
		if (session.queue.length === 0 && this.#orphanQueue.length > 0) {
			session.queue.push(...this.#orphanQueue.splice(0, this.#orphanQueue.length));
		}

		const item = session.queue.shift();
		if (item) {
			this.touch();
		}

		return item;
	}

	public queueFor(selector?: string): QueueItem[] {
		const session = this.resolve(selector);
		return session ? session.queue : this.#orphanQueue;
	}

	public clearQueue(selector?: string): number {
		const session = this.resolve(selector);
		const queue = session ? session.queue : this.#orphanQueue;
		const removed = queue.length;
		queue.length = 0;
		this.touch();
		return removed;
	}

	public removeQueued(index: number, selector?: string): QueueItem | undefined {
		const queue = this.queueFor(selector);
		if (index < 0 || index >= queue.length) {
			return undefined;
		}

		const [item] = queue.splice(index, 1);
		this.touch();
		return item;
	}

	/** Moves the entry at `index` to the front so it runs next. */
	public promoteQueued(index: number, selector?: string): QueueItem | undefined {
		const queue = this.queueFor(selector);
		if (index <= 0 || index >= queue.length) {
			return queue[0];
		}

		const [item] = queue.splice(index, 1);
		queue.unshift(item);
		this.touch();
		return item;
	}

	public setPending(session: SessionState, pending: PendingPermission | undefined): void {
		session.pending = pending;
		this.touch();
	}

	/** The permission request the deck should currently be offering, if any. */
	public firstPending(selector?: string): { session: SessionState; pending: PendingPermission } | undefined {
		const preferred = this.resolve(selector);
		if (preferred?.pending) {
			return { session: preferred, pending: preferred.pending };
		}

		if (selector && selector !== "active") {
			return undefined;
		}

		for (const session of this.list()) {
			if (session.pending) {
				return { session, pending: session.pending };
			}
		}

		return undefined;
	}
}
