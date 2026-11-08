import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { execWhenFound, shellQuote } from "../.test-build/claude/locate.js";

const exec = promisify(execFile);
const posix = process.platform !== "win32";

describe("shellQuote", () => {
	it("survives quotes, spaces and shell metacharacters", async () => {
		const nasty = `it's a "test"; rm -rf / $(whoami) \`id\` | & >out`;
		if (!posix) {
			return;
		}

		const { stdout } = await exec("/bin/sh", ["-c", `printf '%s' ${shellQuote(nasty)}`]);
		assert.equal(stdout, nasty, "the argument must reach the program unchanged");
	});
});

describe("execWhenFound", () => {
	it("runs the binary found on PATH and passes arguments through", async (t) => {
		if (!posix) {
			return t.skip("POSIX only");
		}

		const dir = await mkdtemp(join(tmpdir(), "claude-deck-locate-"));
		const fake = join(dir, "node");
		await writeFile(fake, '#!/bin/sh\nprintf "ran %s" "$1"\n', "utf8");
		await chmod(fake, 0o755);

		const script = execWhenFound("node", ["an arg with spaces"], 'echo MISSING >&2; exit 9');
		const { stdout } = await exec("/bin/sh", ["-c", script], { env: { PATH: dir, HOME: dir } });

		assert.equal(stdout, "ran an arg with spaces");
	});

	it("falls back to the configured paths when PATH has nothing", async (t) => {
		if (!posix) {
			return t.skip("POSIX only");
		}

		// Mimic an nvm install: not on PATH, but under $NVM_DIR/current/bin.
		const home = await mkdtemp(join(tmpdir(), "claude-deck-nvm-"));
		const bin = join(home, ".nvm", "current", "bin");
		await exec("/bin/sh", ["-c", `mkdir -p ${shellQuote(bin)}`]);
		const fake = join(bin, "node");
		await writeFile(fake, '#!/bin/sh\nprintf "nvm-node"\n', "utf8");
		await chmod(fake, 0o755);

		const script = execWhenFound("node", ["x"], 'echo MISSING >&2; exit 9');
		const { stdout } = await exec("/bin/sh", ["-c", script], { env: { PATH: "/nonexistent", HOME: home } });

		assert.equal(stdout, "nvm-node");
	});

	it("reports cleanly when the binary is nowhere", async (t) => {
		if (!posix) {
			return t.skip("POSIX only");
		}

		const home = await mkdtemp(join(tmpdir(), "claude-deck-empty-"));
		const script = execWhenFound("claude", [], 'echo MISSING >&2; exit 9');

		await assert.rejects(
			exec("/bin/sh", ["-c", script], { env: { PATH: "/nonexistent", HOME: home } }),
			(error) => error.code === 9 && String(error.stderr).includes("MISSING"),
		);
	});
});
