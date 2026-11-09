import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The plugin's own `.sdPlugin` folder.
 *
 * Derived from the running bundle (`bin/plugin.js`) rather than the working
 * directory, which Stream Deck does not promise.
 */
export function pluginDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Opens a file with whatever the operating system associates with it.
 *
 * For a `.streamDeckProfile` that is Stream Deck itself, which offers to import
 * it — the one way to get a bundled layout onto a deck that works regardless of
 * how the plugin was installed.
 * @param path Absolute path.
 * @returns An error message, or `undefined` when the file was handed over.
 */
export function openWithSystem(path: string): string | undefined {
	if (!existsSync(path)) {
		return `missing: ${path}`;
	}

	const [command, args] =
		process.platform === "win32"
			? ["cmd.exe", ["/c", "start", "", path]]
			: process.platform === "darwin"
				? ["open", [path]]
				: ["xdg-open", [path]];

	try {
		spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false }).unref();
		return undefined;
	} catch (error) {
		return (error as Error).message;
	}
}
