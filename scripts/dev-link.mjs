/**
 * Links the built plugin into Stream Deck for local development, and restarts
 * the app so it picks the plugin up.
 *
 * The Elgato CLI's own `link` command only works when it runs on the same OS as
 * Stream Deck. This script additionally covers the common Windows setup where
 * the repo and the toolchain live inside WSL while Stream Deck runs on the host.
 *
 * Usage: node scripts/dev-link.mjs [--unlink] [--no-restart]
 */
import { execFile } from "node:child_process";
import { access, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

const UUID = "io.github.claude-deck.plugin";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, `${UUID}.sdPlugin`);

const unlink = process.argv.includes("--unlink");
const restart = !process.argv.includes("--no-restart");

/** True when this is Linux with a Windows filesystem mounted at /mnt/c. */
async function isWsl() {
	if (process.platform !== "linux") {
		return false;
	}

	try {
		await access("/mnt/c/Windows");
		return true;
	} catch {
		return false;
	}
}

/** Runs a Windows executable, from Windows or from inside WSL. */
function win(command, args) {
	return exec(command, args, { windowsHide: true, timeout: 20_000 });
}

/** Translates a Windows path into the /mnt/<drive> form WSL can open. */
function toWslPath(windowsPath) {
	const match = /^([A-Za-z]):\\(.*)$/.exec(windowsPath.trim());
	return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}` : undefined;
}

/** Translates a /mnt/<drive> path back into the Windows form. */
function toWindowsPath(posixPath) {
	const match = /^\/mnt\/([a-z])\/(.*)$/.exec(posixPath);
	return match ? `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}` : undefined;
}

/**
 * Finds Stream Deck's plugins directory for the current host.
 * @returns The directory, plus how to address it from Windows when relevant.
 */
async function pluginsDir() {
	if (process.platform === "darwin") {
		return { path: join(homedir(), "Library", "Application Support", "com.elgato.StreamDeck", "Plugins") };
	}

	if (process.platform === "win32") {
		const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
		return { path: join(appData, "Elgato", "StreamDeck", "Plugins") };
	}

	if (await isWsl()) {
		const { stdout } = await win("cmd.exe", ["/c", "echo %APPDATA%"]);
		const appData = toWslPath(stdout);
		if (!appData) {
			throw new Error(`Could not read %APPDATA% from Windows (got "${stdout.trim()}")`);
		}

		return { path: join(appData, "Elgato", "StreamDeck", "Plugins"), viaWindows: true };
	}

	throw new Error(`Stream Deck is not available on ${process.platform}.`);
}

/** Stops Stream Deck and starts it again, so it re-reads the plugins directory. */
async function restartStreamDeck(viaWindows) {
	if (process.platform === "darwin") {
		await exec("osascript", ["-e", 'quit app "Stream Deck"']).catch(() => {});
		await new Promise((r) => setTimeout(r, 1500));
		await exec("open", ["-a", "Stream Deck"]);
		return;
	}

	const powershell = viaWindows ? "powershell.exe" : "powershell";
	await win(powershell, [
		"-NoProfile",
		"-Command",
		"Stop-Process -Name StreamDeck -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 1500; " +
			"Start-Process 'C:\\Program Files\\Elgato\\StreamDeck\\StreamDeck.exe'",
	]);
}

const { path: plugins, viaWindows } = await pluginsDir();
const target = join(plugins, `${UUID}.sdPlugin`);

await mkdir(plugins, { recursive: true });

// Remove whatever is there now, link or real directory.
const existing = await lstat(target).catch(() => undefined);
if (existing) {
	const kind = existing.isSymbolicLink() ? `link → ${await readlink(target).catch(() => "?")}` : "directory";
	console.log(`removing existing ${kind}`);
	await rm(target, { recursive: true, force: true });
}

if (unlink) {
	console.log(`unlinked ${UUID}`);
} else if (viaWindows) {
	// A Windows junction is what Stream Deck understands; WSL symlinks are invisible to it.
	const from = toWindowsPath(target);
	const to = toWindowsPath(source);
	if (!from || !to) {
		throw new Error("The repository must live on a Windows drive for the junction to work.");
	}

	await win("cmd.exe", ["/c", "mklink", "/J", from, to]);
	console.log(`junction ${from}\n       → ${to}`);
} else {
	await symlink(source, target, "junction");
	console.log(`linked ${target}\n    → ${source}`);
}

if (restart) {
	console.log("restarting Stream Deck…");
	await restartStreamDeck(viaWindows);
}

console.log("done");
