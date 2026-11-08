/**
 * Finding executables the way Claude Code's hooks have to find them.
 *
 * Hooks and `wsl.exe` both spawn commands without an interactive shell. Ubuntu's
 * `.bashrc` returns early when not interactive, so a version manager (nvm, fnm,
 * volta, bun) never loads and a bare `node` or `claude` is simply not found —
 * even though it works perfectly in the user's own terminal. Everything here
 * exists to close that gap without assuming any particular install method.
 */

/** Wraps a value so a POSIX shell sees it as a single literal argument. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Directories an executable may live in, per install method. */
const SEARCH_PATHS: Record<string, string[]> = {
	node: [
		'"${NVM_DIR:-$HOME/.nvm}/current/bin/node"',
		'"$HOME/.volta/bin/node"',
		'"$HOME/.local/share/fnm/aliases/default/bin/node"',
		'"$HOME/.asdf/shims/node"',
		'"$HOME/.bun/bin/node"',
		"/usr/local/bin/node",
		"/usr/bin/node",
		"/opt/homebrew/bin/node",
	],
	claude: [
		'"$HOME/.local/bin/claude"',
		'"$HOME/.claude/local/claude"',
		'"${NVM_DIR:-$HOME/.nvm}/current/bin/claude"',
		'"$HOME/.volta/bin/claude"',
		'"$HOME/.bun/bin/claude"',
		'"$HOME/.asdf/shims/claude"',
		"/usr/local/bin/claude",
		"/usr/bin/claude",
		"/opt/homebrew/bin/claude",
	],
};

/**
 * Builds a POSIX snippet that locates `binary` and hands over to it.
 *
 * Uses `exec` so the child replaces the shell: stdin, stdout and the exit code
 * all pass straight through, which matters because the idle-wake helper signals
 * Claude Code with exit code 2.
 * @param binary Executable to find — `node` or `claude`.
 * @param args Arguments to pass, quoted for the shell.
 * @param onMissing Shell lines to run when nothing was found.
 * @param options Set `raw` when the arguments are already shell-ready, e.g. `"$@"`.
 * @returns The snippet.
 */
export function execWhenFound(
	binary: "node" | "claude",
	args: string[],
	onMissing: string,
	options: { raw?: boolean } = {},
): string {
	const quoted = (options.raw ? args : args.map(shellQuote)).join(" ");
	const candidates = [`"$(command -v ${binary} 2>/dev/null)"`, ...SEARCH_PATHS[binary]];
	const glob = `"\${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/${binary}`;

	return `for candidate in ${candidates.join(" ")}
do
	[ -n "$candidate" ] && [ -x "$candidate" ] && exec "$candidate" ${quoted}
done

# Last resort: the newest version a Node manager has installed.
newest=$(ls -1d ${glob} 2>/dev/null | sort -V | tail -n 1)
[ -n "$newest" ] && [ -x "$newest" ] && exec "$newest" ${quoted}

${onMissing}`;
}
