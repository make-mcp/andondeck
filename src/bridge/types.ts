/**
 * Shapes exchanged with Claude Code's HTTP hooks.
 *
 * Claude Code POSTs the hook input to the bridge and uses the JSON body of the
 * response as the hook output, which is what lets the deck answer permission
 * requests and feed queued prompts back into a finished turn.
 * @see https://code.claude.com/docs/en/hooks
 */

/** Fields Claude Code sends on every hook event. */
export type HookCommon = {
	session_id: string;
	transcript_path?: string;
	cwd?: string;
	permission_mode?: PermissionMode;
	hook_event_name: string;
	agent_id?: string;
	agent_type?: string;
	effort?: { level?: string };
};

export type PermissionMode = "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";

export type HookInput = HookCommon & Record<string, unknown>;

/** Everything the bridge may answer with; omitted keys mean "no opinion". */
export type HookOutput = {
	decision?: "block";
	reason?: string;
	continue?: boolean;
	stopReason?: string;
	systemMessage?: string;
	/** OSC/BEL escape asking the terminal to raise a notification. */
	terminalSequence?: string;
	hookSpecificOutput?: Record<string, unknown>;
};

/** Lifecycle state of a single Claude Code session, as the deck understands it. */
export type SessionStatus = "idle" | "working" | "waiting" | "compacting" | "error" | "ended";

export type PendingPermission = {
	toolUseId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
	summary: string;
	rule?: string;
	receivedAt: number;
	expiresAt: number;
};

export type QueueItem = {
	id: string;
	text: string;
	addedAt: number;
	/** Label shown on the deck; defaults to a truncated {@link QueueItem.text}. */
	label?: string;
};

export type SessionUsage = {
	turns: number;
	toolCalls: number;
	/** Milliseconds spent inside turns, excluding idle time. */
	busyMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	/** Context tokens in use at the last sample, when the transcript could be read. */
	contextTokens: number;
	costUsd: number;
};

/** Tools that only read; safe to wave through when auto-approve is limited. */
export const READ_ONLY_TOOLS = [
	"Read",
	"Grep",
	"Glob",
	"NotebookRead",
	"WebSearch",
	"WebFetch",
	"TodoWrite",
	"TaskOutput",
	"ListAgents",
] as const;

/** How much the deck is currently approving on the user's behalf. */
export type AutoApproveMode = "off" | "safe" | "all";

export type AutoApprove = {
	mode: AutoApproveMode;
	/** Epoch milliseconds after which it reverts to `off`; 0 means no expiry. */
	until: number;
};

export type SessionState = {
	sessionId: string;
	cwd: string;
	project: string;
	status: SessionStatus;
	model?: string;
	permissionMode?: PermissionMode;
	currentTool?: string;
	lastPrompt?: string;
	lastAssistantMessage?: string;
	lastError?: string;
	turnNumber: number;
	turnStartedAt?: number;
	lastEventAt: number;
	startedAt: number;
	subagents: number;
	transcriptPath?: string;
	/** `WSL_DISTRO_NAME` reported by the hook, when Claude Code runs inside WSL. */
	wslDistro?: string;
	queue: QueueItem[];
	pending?: PendingPermission;
	/** Set while the user has pulled the emergency brake on this session. */
	haltedAt?: number;
	/** Tool calls denied since the brake was pulled. */
	haltedCalls: number;
	usage: SessionUsage;
};

/** Snapshot of a session that is safe to hand to the property inspector. */
export type SessionSummary = Pick<
	SessionState,
	"sessionId" | "project" | "cwd" | "status" | "model" | "permissionMode" | "lastEventAt"
> & { queued: number };
