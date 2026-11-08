import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Clipboard text longer than this is almost certainly a mistake on a key. */
const MAX_LENGTH = 20_000;

/**
 * Reads the system clipboard.
 *
 * Copying an error message and pressing one key beats retyping it, which is the
 * whole point of a prompt key that can pull from the clipboard.
 * @returns The text, or `undefined` when the clipboard is empty or unreadable.
 */
export async function readClipboard(): Promise<string | undefined> {
	const attempts: [string, string[]][] =
		process.platform === "win32"
			? [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]]]
			: process.platform === "darwin"
				? [["pbpaste", []]]
				: [
						["wl-paste", ["--no-newline"]],
						["xclip", ["-selection", "clipboard", "-o"]],
						["xsel", ["--clipboard", "--output"]],
					];

	for (const [command, args] of attempts) {
		try {
			const { stdout } = await exec(command, args, { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
			const text = stdout.replace(/\r\n/g, "\n").trim();
			if (text) {
				return text.slice(0, MAX_LENGTH);
			}
		} catch {
			// Try the next tool; Linux in particular has several.
		}
	}

	return undefined;
}
