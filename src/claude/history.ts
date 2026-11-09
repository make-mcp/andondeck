import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { PlanLimits } from "../bridge/types.js";

/** How far back history reaches. A week of days, plus a day of margin. */
const RETENTION_MS = 8 * 24 * 3_600_000;

/** Transcripts are rescanned at most this often. */
const RESCAN_MS = 60_000;

/** Bytes read per chunk while catching up on a transcript. */
const CHUNK_BYTES = 1024 * 1024;

const HOUR_MS = 3_600_000;

/** One assistant response's token use, as the transcript records it. */
export type UsageEntry = {
	/** Message id plus request id; the same response is logged once per content block. */
	key: string;
	/** Epoch milliseconds. */
	at: number;
	/** Input, output, cache writes and cache reads — the total the API bills against. */
	tokens: number;
};

/**
 * Pulls the token use out of one transcript line.
 *
 * Cheap rejection first: almost every line is a tool result or a prompt, and
 * parsing them all would make a first scan of a busy week slow.
 * @param line One JSONL line.
 * @returns The entry, or `undefined` when the line is not a usage-bearing response.
 */
export function parseUsageLine(line: string): UsageEntry | undefined {
	if (!line.includes('"usage"') || !line.includes('"assistant"')) {
		return undefined;
	}

	let entry: Record<string, unknown>;
	try {
		entry = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return undefined;
	}

	const message = entry.message as Record<string, unknown> | undefined;
	const usage = message?.usage as Record<string, unknown> | undefined;
	const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
	if (!usage || Number.isNaN(at)) {
		return undefined;
	}

	const count = (field: string) => (typeof usage[field] === "number" ? (usage[field] as number) : 0);
	const tokens =
		count("input_tokens") + count("output_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens");
	if (tokens <= 0) {
		return undefined;
	}

	const id = typeof message?.id === "string" ? message.id : "";
	const request = typeof entry.requestId === "string" ? entry.requestId : "";
	// Without either id there is nothing to deduplicate on; the line's own
	// timestamp and size are the next best thing.
	const key = id || request ? `${id}:${request}` : `${at}:${tokens}`;

	return { key, at, tokens };
}

/** Start of the local calendar day containing `at`. */
function dayStart(at: number): number {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/**
 * Token use over time, read from Claude Code's transcripts.
 *
 * Reading the transcripts rather than counting live means history is there
 * from the first moment: the week before the plugin was installed included.
 * Each file is read once and then followed from where the last read stopped.
 */
export class UsageHistory {
	/** Per transcript: how far it has been read. */
	readonly #files = new Map<string, number>();
	/** Responses already counted, by key, with the hour they fell in. */
	readonly #seen = new Map<string, number>();
	/** Tokens per hour, keyed by the hour's start. */
	readonly #hours = new Map<number, number>();

	#lastScan = 0;
	#scanning: Promise<boolean> | undefined;

	/** Records one entry, ignoring repeats and anything outside the window. */
	public add(entry: UsageEntry, now = Date.now()): boolean {
		if (entry.at < now - RETENTION_MS || this.#seen.has(entry.key)) {
			return false;
		}

		const hour = Math.floor(entry.at / HOUR_MS) * HOUR_MS;
		this.#seen.set(entry.key, hour);
		this.#hours.set(hour, (this.#hours.get(hour) ?? 0) + entry.tokens);
		return true;
	}

	/**
	 * Tokens per hour for the last `count` hours, oldest first; the last entry
	 * is the hour in progress.
	 */
	public hourly(count: number, now = Date.now()): number[] {
		const current = Math.floor(now / HOUR_MS) * HOUR_MS;
		return Array.from({ length: count }, (_, index) => this.#hours.get(current - (count - 1 - index) * HOUR_MS) ?? 0);
	}

	/**
	 * Tokens per local calendar day for the last `count` days, oldest first;
	 * the last entry is today.
	 */
	public daily(count: number, now = Date.now()): number[] {
		const today = dayStart(now);
		const days = new Map<number, number>();
		for (const [hour, tokens] of this.#hours) {
			const day = dayStart(hour);
			days.set(day, (days.get(day) ?? 0) + tokens);
		}

		return Array.from({ length: count }, (_, index) => {
			// Step back by calendar day, not by 24 hours, so a DST change cannot
			// put two days in one bar.
			const date = new Date(today);
			date.setDate(date.getDate() - (count - 1 - index));
			return days.get(date.getTime()) ?? 0;
		});
	}

	/** Whether anything has been counted yet. */
	public get empty(): boolean {
		return this.#hours.size === 0;
	}

	/**
	 * Catches up on every transcript under the given project roots.
	 * @param roots Claude Code `projects` directories the plugin can read.
	 * @param force Rescan even if the last scan was recent.
	 * @returns Whether anything new was counted.
	 */
	public refresh(roots: string[], force = false): Promise<boolean> {
		if (this.#scanning) {
			return this.#scanning;
		}
		if (!force && Date.now() - this.#lastScan < RESCAN_MS) {
			return Promise.resolve(false);
		}

		this.#scanning = this.#scan(roots).finally(() => {
			this.#lastScan = Date.now();
			this.#scanning = undefined;
		});
		return this.#scanning;
	}

	async #scan(roots: string[]): Promise<boolean> {
		const now = Date.now();
		let changed = false;

		for (const root of new Set(roots)) {
			for (const file of await transcripts(root, now - RETENTION_MS)) {
				changed = (await this.#follow(file, now)) || changed;
			}
		}

		this.#prune(now);
		return changed;
	}

	/** Reads whatever was appended to a transcript since the last look. */
	async #follow(file: { path: string; size: number }, now: number): Promise<boolean> {
		let offset = this.#files.get(file.path) ?? 0;
		// Shrunk means rewritten; start over and let the dedupe skip what was counted.
		if (file.size < offset) {
			offset = 0;
		}
		if (file.size === offset) {
			return false;
		}

		let changed = false;
		try {
			const handle = await open(file.path, "r");
			try {
				// Split on bytes, not characters: a chunk boundary can fall inside
				// a multi-byte character, and decoding before splitting would
				// corrupt that line.
				let carry = Buffer.alloc(0);
				while (offset < file.size) {
					const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, file.size - offset));
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
					if (bytesRead === 0) {
						break;
					}
					offset += bytesRead;

					const data = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
					const end = data.lastIndexOf(0x0a);
					// Only whole lines count; a line still being written is picked up next time.
					carry = end === -1 ? data : data.subarray(end + 1);
					if (end === -1) {
						continue;
					}

					for (const line of data.toString("utf8", 0, end).split("\n")) {
						const entry = parseUsageLine(line);
						if (entry) {
							changed = this.add(entry, now) || changed;
						}
					}
				}
				offset -= carry.length;
			} finally {
				await handle.close();
			}
		} catch {
			return changed;
		}

		this.#files.set(file.path, offset);
		return changed;
	}

	#prune(now: number): void {
		const floor = Math.floor((now - RETENTION_MS) / HOUR_MS) * HOUR_MS;
		for (const [hour] of this.#hours) {
			if (hour < floor) {
				this.#hours.delete(hour);
			}
		}
		for (const [key, hour] of this.#seen) {
			if (hour < floor) {
				this.#seen.delete(key);
			}
		}
	}
}

/**
 * Lists transcripts touched since `since`, including sub-agent transcripts a
 * level or two further down.
 */
async function transcripts(root: string, since: number, depth = 0): Promise<{ path: string; size: number }[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}

	const found: { path: string; size: number }[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory() && depth < 3 && entry.name !== "memory") {
			found.push(...(await transcripts(path, since, depth + 1)));
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			try {
				const info = await stat(path);
				if (info.mtimeMs >= since) {
					found.push({ path, size: info.size });
				}
			} catch {
				// Gone between listing and stat; nothing to count.
			}
		}
	}
	return found;
}

/** One reading of the plan limits. */
export type PlanSample = {
	at: number;
	/** 5-hour window: percent used, and when it resets. */
	five?: [number, number];
	/** Weekly window: percent used, and when it resets. */
	week?: [number, number];
};

/** A reading is kept at most this often, unless the numbers moved. */
const SAMPLE_MS = 2 * 60_000;

/** Writes to disk are batched this long. */
const SAVE_MS = 5 * 60_000;

/** Where the plugin keeps data of its own, outside the plugin folder an update replaces. */
export function dataDir(): string {
	if (process.platform === "win32") {
		return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "claude-deck");
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support", "claude-deck");
	}
	return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "claude-deck");
}

/**
 * The plan limits as they moved.
 *
 * Claude Code reports only the current percentage. Keeping the readings is what
 * turns "62 %" into "full in 1h 20m" — the number that decides whether to keep
 * going or to switch to a cheaper model.
 */
export class PlanTrend {
	#samples: PlanSample[] = [];
	#dirty = false;
	#saveTimer: NodeJS.Timeout | undefined;

	constructor(private readonly file = join(dataDir(), "plan-history.json")) {}

	public get samples(): readonly PlanSample[] {
		return this.#samples;
	}

	public async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown;
			if (Array.isArray(parsed)) {
				const floor = Date.now() - RETENTION_MS;
				this.#samples = (parsed as PlanSample[]).filter((sample) => typeof sample?.at === "number" && sample.at >= floor);
			}
		} catch {
			// First run, or unreadable: start a fresh history.
		}
	}

	/** Takes in a fresh status line reading. */
	public record(limits: PlanLimits, now = Date.now()): void {
		const sample: PlanSample = { at: now };
		if (limits.fiveHour) {
			sample.five = [limits.fiveHour.usedPercent, limits.fiveHour.resetsAt];
		}
		if (limits.sevenDay) {
			sample.week = [limits.sevenDay.usedPercent, limits.sevenDay.resetsAt];
		}

		const last = this.#samples.at(-1);
		const moved = !last || last.five?.[0] !== sample.five?.[0] || last.week?.[0] !== sample.week?.[0];
		if (!moved && now - last.at < SAMPLE_MS) {
			return;
		}

		this.#samples.push(sample);
		const floor = now - RETENTION_MS;
		while (this.#samples.length > 0 && this.#samples[0].at < floor) {
			this.#samples.shift();
		}
		this.#scheduleSave();
	}

	/**
	 * Readings inside the current window of one limit, oldest first.
	 * @param window Which limit.
	 * @param resetsAt The current window's reset, which identifies it.
	 */
	public within(window: "five" | "week", resetsAt: number): { at: number; used: number }[] {
		// Resets are reported to the second and drift by a little between
		// readings; anything within a minute is the same window.
		return this.#samples
			.filter((sample) => sample[window] && Math.abs(sample[window]![1] - resetsAt) < 60_000)
			.map((sample) => ({ at: sample.at, used: sample[window]![0] }));
	}

	#scheduleSave(): void {
		this.#dirty = true;
		if (this.#saveTimer) {
			return;
		}
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			void this.flush();
		}, SAVE_MS);
		this.#saveTimer.unref?.();
	}

	public async flush(): Promise<void> {
		if (!this.#dirty) {
			return;
		}
		this.#dirty = false;
		try {
			await mkdir(dirname(this.file), { recursive: true });
			await writeFile(this.file, JSON.stringify(this.#samples), "utf8");
		} catch {
			// History is a nicety; losing a few readings must never break the deck.
		}
	}
}

/**
 * When a limit will be used up at the recent pace.
 *
 * Fitted to the last hour of readings in the current window, because the pace
 * that matters is the one right now, not the average since the window opened.
 * @param points Readings in the current window, oldest first.
 * @param now Current time.
 * @returns Epoch milliseconds at which usage reaches 100 %, or `undefined`
 *   when it is not rising or there is too little to go on.
 */
export function projectFull(points: { at: number; used: number }[], now = Date.now()): number | undefined {
	const recent = points.filter((point) => point.at >= now - HOUR_MS);
	if (recent.length < 2 || recent.at(-1)!.at - recent[0].at < 10 * 60_000) {
		return undefined;
	}

	// Least-squares slope, in percent per millisecond.
	const meanT = recent.reduce((sum, point) => sum + point.at, 0) / recent.length;
	const meanU = recent.reduce((sum, point) => sum + point.used, 0) / recent.length;
	let num = 0;
	let den = 0;
	for (const point of recent) {
		num += (point.at - meanT) * (point.used - meanU);
		den += (point.at - meanT) ** 2;
	}
	const slope = den === 0 ? 0 : num / den;
	if (slope <= 0) {
		return undefined;
	}

	const latest = recent.at(-1)!;
	return latest.at + (100 - latest.used) / slope;
}
