import { open, stat } from "node:fs/promises";

import { localizePath } from "./env.js";

/** Bytes read from the end of a transcript when sampling usage. */
const TAIL_BYTES = 256 * 1024;

export type UsageSample = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	/** Approximate context occupancy of the last request. */
	contextTokens: number;
	/** Only populated when the transcript itself records a cost; never estimated. */
	costUsd: number;
	model?: string;
};

type TranscriptUsage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
};

/**
 * Reads token counters from the last assistant entry of a Claude Code transcript.
 *
 * Entirely best-effort: the transcript lives wherever Claude Code runs, which
 * may be a WSL filesystem or not readable at all, so every failure is swallowed
 * and the deck simply falls back to the counters it tracked from hook events.
 * @param transcriptPath Path as reported by the hook.
 * @param distro WSL distribution the hook ran in, when applicable.
 * @returns The sample, or `undefined` when the transcript could not be read.
 */
export async function readTranscriptUsage(transcriptPath: string, distro?: string): Promise<UsageSample | undefined> {
	const path = localizePath(transcriptPath, distro);
	if (!path) {
		return undefined;
	}

	try {
		const { size } = await stat(path);
		const start = Math.max(0, size - TAIL_BYTES);
		const handle = await open(path, "r");

		try {
			const buffer = Buffer.alloc(Math.min(TAIL_BYTES, size));
			await handle.read(buffer, 0, buffer.length, start);
			return parseTail(buffer.toString("utf8"), start > 0);
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

/**
 * Finds the newest usage block in a slice of JSONL.
 * @param text The slice.
 * @param partialFirstLine Whether the slice starts mid-line and line 0 must be skipped.
 * @returns The sample, or `undefined` when no entry carried usage.
 */
function parseTail(text: string, partialFirstLine: boolean): UsageSample | undefined {
	const lines = text.split("\n");
	const floor = partialFirstLine ? 1 : 0;

	for (let i = lines.length - 1; i >= floor; i--) {
		const line = lines[i].trim();
		if (!line.startsWith("{")) {
			continue;
		}

		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		const message = (entry.message ?? entry) as Record<string, unknown>;
		const usage = message.usage as TranscriptUsage | undefined;
		if (!usage) {
			continue;
		}

		const input = usage.input_tokens ?? 0;
		const output = usage.output_tokens ?? 0;
		const cacheRead = usage.cache_read_input_tokens ?? 0;
		const cacheCreate = usage.cache_creation_input_tokens ?? 0;

		return {
			inputTokens: input,
			outputTokens: output,
			cacheReadTokens: cacheRead,
			contextTokens: input + cacheRead + cacheCreate,
			costUsd: typeof entry.costUSD === "number" ? entry.costUSD : 0,
			model: typeof message.model === "string" ? message.model : undefined,
		};
	}

	return undefined;
}
