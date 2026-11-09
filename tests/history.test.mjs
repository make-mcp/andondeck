import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import sharp from "sharp";

import { PlanTrend, UsageHistory, parseUsageLine, projectFull } from "../.test-build/claude/history.js";
import { strip, tile } from "../.test-build/ui/render.js";

const HOUR = 3_600_000;

/** A transcript line shaped like the ones Claude Code writes. */
function response({ id, request = `req_${id}`, at, input = 2, output = 100, cacheRead = 1000, cacheWrite = 0, text = "" }) {
	return JSON.stringify({
		type: "assistant",
		timestamp: new Date(at).toISOString(),
		requestId: request,
		message: {
			id,
			role: "assistant",
			content: [{ type: "text", text }],
			usage: {
				input_tokens: input,
				output_tokens: output,
				cache_read_input_tokens: cacheRead,
				cache_creation_input_tokens: cacheWrite,
			},
		},
	});
}

describe("usage history", () => {
	it("counts every kind of token in a response", () => {
		const entry = parseUsageLine(response({ id: "m1", at: Date.now(), input: 5, output: 7, cacheRead: 11, cacheWrite: 13 }));
		assert.equal(entry.tokens, 36);
		assert.equal(entry.key, "m1:req_m1");
	});

	it("ignores lines that carry no usage", () => {
		assert.equal(parseUsageLine(JSON.stringify({ type: "user", message: { content: "hi" } })), undefined);
		assert.equal(parseUsageLine("not json"), undefined);
		assert.equal(parseUsageLine(""), undefined);
	});

	it("counts a response once although the transcript logs it per content block", () => {
		const history = new UsageHistory();
		const now = Date.now();
		const line = response({ id: "m1", at: now });
		history.add(parseUsageLine(line), now);
		history.add(parseUsageLine(line), now);
		assert.equal(history.hourly(1, now)[0], 1102);
	});

	it("buckets by hour and by local day, newest last", () => {
		const history = new UsageHistory();
		const now = new Date(2026, 10, 9, 15, 30).getTime();
		history.add(parseUsageLine(response({ id: "a", at: now, output: 0, cacheRead: 0, input: 10 })), now);
		history.add(parseUsageLine(response({ id: "b", at: now - HOUR, output: 0, cacheRead: 0, input: 20 })), now);
		history.add(parseUsageLine(response({ id: "c", at: now - 24 * HOUR, output: 0, cacheRead: 0, input: 40 })), now);

		assert.deepEqual(history.hourly(3, now), [0, 20, 10]);
		assert.deepEqual(history.daily(2, now), [40, 30]);
	});

	it("drops anything older than its window", () => {
		const history = new UsageHistory();
		const now = Date.now();
		assert.equal(history.add(parseUsageLine(response({ id: "old", at: now - 30 * 24 * HOUR })), now), false);
		assert.equal(history.empty, true);
	});

	it("follows transcripts as they grow, including multi-byte text across reads", async () => {
		const root = await mkdtemp(join(tmpdir(), "claude-deck-history-"));
		const project = join(root, "-home-me-project");
		await mkdir(join(project, "session", "subagents"), { recursive: true });
		const now = Date.now();

		// Long enough to cross the 1 MiB read size, with umlauts all the way.
		const filler = "Ä".repeat(600_000);
		await writeFile(join(project, "s1.jsonl"), `${response({ id: "m1", at: now, text: filler })}\n`);
		await writeFile(join(project, "session", "subagents", "agent.jsonl"), `${response({ id: "m2", at: now })}\n`);

		const history = new UsageHistory();
		assert.equal(await history.refresh([root], true), true);
		assert.equal(history.hourly(1)[0], 2204);

		// Half a line is not counted until it is finished.
		const next = response({ id: "m3", at: now });
		await appendFile(join(project, "s1.jsonl"), next.slice(0, 40));
		assert.equal(await history.refresh([root], true), false);
		await appendFile(join(project, "s1.jsonl"), `${next.slice(40)}\n`);
		assert.equal(await history.refresh([root], true), true);
		assert.equal(history.hourly(1)[0], 3306);
	});

	it("survives a root it cannot read", async () => {
		const history = new UsageHistory();
		assert.equal(await history.refresh([join(tmpdir(), "does-not-exist-claude-deck")], true), false);
	});
});

describe("plan trend", () => {
	it("projects when a rising limit runs out", () => {
		const now = Date.now();
		// 1 % every 5 minutes, at 50 % now: 50 more percent takes 250 minutes.
		const points = Array.from({ length: 7 }, (_, index) => ({ at: now - (6 - index) * 300_000, used: 44 + index }));
		const fullAt = projectFull(points, now);
		assert.ok(Math.abs(fullAt - (now + 250 * 60_000)) < 1000);
	});

	it("makes no projection from too little or a flat line", () => {
		const now = Date.now();
		assert.equal(projectFull([{ at: now, used: 10 }], now), undefined);
		assert.equal(projectFull([{ at: now - 60_000, used: 10 }, { at: now, used: 12 }], now), undefined);
		assert.equal(projectFull([{ at: now - 1_800_000, used: 10 }, { at: now, used: 10 }], now), undefined);
	});

	it("keeps readings per window and writes them out", async () => {
		const file = join(await mkdtemp(join(tmpdir(), "claude-deck-plan-")), "plan.json");
		const trend = new PlanTrend(file);
		const now = Date.now();
		const reset = now + 2 * HOUR;
		trend.record({ fiveHour: { usedPercent: 10, resetsAt: reset }, updatedAt: now }, now);
		trend.record({ fiveHour: { usedPercent: 10, resetsAt: reset }, updatedAt: now }, now + 1000);
		trend.record({ fiveHour: { usedPercent: 12, resetsAt: reset + 400 }, updatedAt: now }, now + 2000);
		trend.record({ fiveHour: { usedPercent: 1, resetsAt: reset + 5 * HOUR }, updatedAt: now }, now + 3000);

		assert.deepEqual(
			trend.within("five", reset).map((point) => point.used),
			[10, 12],
		);

		await trend.flush();
		const again = new PlanTrend(file);
		await again.load();
		assert.equal(again.samples.length, 3);
		assert.equal(JSON.parse(await readFile(file, "utf8")).length, 3);
	});
});

describe("charts", () => {
	it("draws bars and lines on a key and on a dial strip", async () => {
		const key = tile({
			family: "meter",
			tone: "accent",
			eyebrow: "7 days",
			headline: "412M",
			chart: { kind: "bars", series: [1, 5, 0, 9, 3, 7, 4] },
		});
		const dial = strip({
			title: "5h limit",
			value: "62%",
			subtitle: "full in 1h 20m",
			tone: "waiting",
			chart: { kind: "line", max: 100, series: [10, 20, 35, 50, 62] },
		});

		for (const [uri, width, height] of [
			[key, 72, 72],
			[dial, 200, 100],
		]) {
			const svg = Buffer.from(uri.split(",")[1], "base64");
			const meta = await sharp(svg).metadata();
			assert.equal(meta.width, width);
			assert.equal(meta.height, height);
		}

		const markup = Buffer.from(key.split(",")[1], "base64").toString("utf8");
		// One bar per day; the bars are the only shapes with a sub-2 corner radius.
		assert.equal((markup.match(/<rect [^>]*rx="[01]\.\d\d"/g) ?? []).length, 7);
	});

	it("survives an empty or flat series", () => {
		assert.ok(tile({ tone: "accent", headline: "0", chart: { kind: "bars", series: [] } }));
		assert.ok(strip({ title: "Today", value: "0", tone: "accent", chart: { kind: "line", series: [0, 0, 0] } }));
	});
});
