import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { join, posix } from "node:path";

import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { Bridge } from "./bridge/server.js";
import {
	hooksInstalled,
	installedHookUrl,
	installHooks,
	setAutoCompactWindow,
	statusLineInstalled,
	uninstallHooks,
} from "./claude/hooks.js";
import { helperPath } from "./claude/helpers.js";
import { PlanTrend, UsageHistory } from "./claude/history.js";
import { setGhosts } from "./ui/render.js";
import { ALERT_PROFILE_FOR_DEVICE } from "./profiles.js";
import {
	claudeHome,
	detectClaudeLocations,
	localizePath,
	hasMirroredNetworking,
	listWslDistros,
	probeReachability,
	resolveClaudeLocation,
	resolveNodeCommand,
	wslHostAddress,
} from "./claude/env.js";
import type { ClaudeLocation } from "./claude/env.js";
import type { Runner } from "./claude/headless.js";

/** Default bridge port; high, static and unlikely to collide. */
export const DEFAULT_PORT = 38274;

/** How often the installed hook URL is checked against the live one. */
const RECONCILE_INTERVAL_MS = 60_000;

export type GlobalSettings = {
	port: number;
	/** Bind on all interfaces so Claude Code inside WSL can reach the bridge. */
	exposeToWsl: boolean;
	token: string;
	/** Answer permission requests from the deck instead of the terminal. */
	deckApprovals: boolean;
	approvalTimeoutSec: number;
	/** Let the deck wake an idle session with a queued prompt. */
	idleWake: boolean;
	/** Ask the terminal to raise a notification when Claude needs attention. */
	notifyTerminal: boolean;
	hooksInstalled: boolean;
	runner: Runner;
	distro: string;
	defaultCwd: string;
	/** Explicit Claude Code settings.json, for installs the detection cannot find. */
	settingsOverride: string;
	/**
	 * Claude Code's `autoCompactWindow`, in thousands of tokens, or `"auto"`.
	 * Empty leaves whatever the user configured themselves untouched.
	 */
	autoCompactK: string;
	/** Read plan limits from Claude Code's status line, chaining any existing one. */
	planLimits: boolean;
	/** Faint Clawd in the background of action keys. */
	ghosts: boolean;
	/** Take over the whole deck with Clawd when Claude asks for something. */
	alertTakeover: boolean;
	[key: string]: JsonValue;
};

const DEFAULTS: GlobalSettings = {
	port: DEFAULT_PORT,
	exposeToWsl: false,
	token: "",
	deckApprovals: true,
	approvalTimeoutSec: 45,
	idleWake: true,
	notifyTerminal: true,
	hooksInstalled: false,
	runner: "auto",
	distro: "",
	defaultCwd: "",
	settingsOverride: "",
	autoCompactK: "",
	planLimits: true,
	ghosts: true,
	alertTakeover: true,
};

export type RuntimeEvents = {
	/** Something an action renders has changed. */
	change: [];
	/** A short message worth surfacing on a key or as a notification. */
	notify: [{ title: string; body: string }];
};

/**
 * Process-wide state shared by every action: the hook bridge, the plugin's
 * global settings, and the bookkeeping that decides whether permission requests
 * are held open for the deck to answer.
 */
class Runtime extends EventEmitter<RuntimeEvents> {
	#settings: GlobalSettings = { ...DEFAULTS };
	#bridge: Bridge | undefined;
	#ready: Promise<void> | undefined;

	/** Contexts of currently visible Approve actions; approvals are only held while one is on screen. */
	readonly #approvers = new Set<string>();

	/** Token use per hour and day, read from the transcripts. */
	public readonly history = new UsageHistory();

	/** Plan-limit readings over time, for trends and projections. */
	public readonly planTrend = new PlanTrend();

	/** Sessions already waiting at the last look, so each request alerts once. */
	#waitingSeen = new Set<string>();

	/** Devices currently showing the alert profile. */
	readonly #alerting = new Set<string>();

	public get settings(): Readonly<GlobalSettings> {
		return this.#settings;
	}

	/** Whether {@link start} has got far enough for keys to draw from it. */
	public get started(): boolean {
		return this.#bridge !== undefined;
	}

	public get bridge(): Bridge {
		if (!this.#bridge) {
			throw new Error("Runtime used before start()");
		}
		return this.#bridge;
	}

	public get store() {
		return this.bridge.store;
	}

	/** Boots the bridge once, reusing the same promise for every caller. */
	public start(): Promise<void> {
		this.#ready ??= this.#start();
		return this.#ready;
	}

	async #start(): Promise<void> {
		const stored = await streamDeck.settings.getGlobalSettings<Partial<GlobalSettings>>();
		this.#settings = { ...DEFAULTS, ...stored };
		setGhosts(this.#settings.ghosts !== false);

		if (!this.#settings.token) {
			this.#settings.token = randomBytes(24).toString("base64url");
			await streamDeck.settings.setGlobalSettings(this.#settings);
		}

		const location = await this.location();
		this.#settings.hooksInstalled = await hooksInstalled(location.settingsPath).catch(() => false);

		const bridge = new Bridge({
			port: this.#settings.port,
			exposeToWsl: this.#settings.exposeToWsl,
			token: this.#settings.token,
			deckApprovals: false,
			approvalTimeoutMs: this.#settings.approvalTimeoutSec * 1000,
			notifyTerminal: this.#settings.notifyTerminal,
		});

		bridge.on("change", () => {
			this.emit("change");
			void this.#checkAlert();
		});
		bridge.on("log", (message) => streamDeck.logger.info(message));
		bridge.on("notify", ({ title, body }) => this.emit("notify", { title, body }));
		bridge.on("limits", (limits) => this.planTrend.record(limits));

		// Assigned before anything else is awaited: keys repaint on their own
		// clock and must never find a half-started runtime.
		this.#bridge = bridge;
		await this.planTrend.load();
		await bridge.start();
		this.#syncApprovalMode();

		// The bridge may have landed on a different port than the one requested.
		if (bridge.options.port !== this.#settings.port) {
			this.#settings.port = bridge.options.port;
			await streamDeck.settings.setGlobalSettings(this.#settings);
		}

		// A WSL gateway address changes on every `wsl --shutdown`, and a port can
		// move; both leave the installed hooks pointing nowhere. Repair quietly.
		void this.reconcile();
		setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS).unref?.();
		streamDeck.system.onSystemDidWakeUp(() => void this.reconcile());

		// Property inspectors bind straight to global settings, so mirror their edits.
		streamDeck.settings.onDidReceiveGlobalSettings<Partial<GlobalSettings>>((ev) => {
			void this.#adopt(ev.settings);
		});
	}

	/**
	 * Takes over every deck with the alert profile when a session starts
	 * waiting, and gives the decks back once nothing waits any more.
	 *
	 * Only a session newly waiting raises it: after a press sends you back, the
	 * same request does not pull you away again.
	 */
	async #checkAlert(): Promise<void> {
		const waiting = this.store.list().filter((session) => session.status === "waiting");
		const fresh = waiting.some((session) => !this.#waitingSeen.has(session.sessionId));
		this.#waitingSeen = new Set(waiting.map((session) => session.sessionId));

		if (waiting.length === 0) {
			if (this.#alerting.size > 0) {
				streamDeck.logger.info("alert: nothing waits any more, giving the decks back");
				await this.dismissAlert();
			}
			return;
		}

		if (!fresh || !this.#settings.alertTakeover) {
			return;
		}

		for (const device of streamDeck.devices) {
			const profile = ALERT_PROFILE_FOR_DEVICE[device.type as number];
			if (!profile || !device.isConnected || this.#alerting.has(device.id)) {
				continue;
			}
			this.#alerting.add(device.id);
			streamDeck.logger.info(`alert: ${device.name} switches to ${profile}`);
			await streamDeck.profiles.switchToProfile(device.id, profile).catch((error: Error) => {
				this.#alerting.delete(device.id);
				streamDeck.logger.warn(`alert: could not switch ${device.name}: ${error.message}`);
			});

			// Stream Deck takes the request without saying whether the profile
			// exists. If no alert key shows up, it was never installed: say so,
			// and do not later "switch back" a deck that never left.
			setTimeout(() => {
				const shown = [...streamDeck.actions].some(
					(unit) => unit.manifestId === "io.github.claude-deck.plugin.alert" && unit.device.id === device.id,
				);
				if (!shown && this.#alerting.delete(device.id)) {
					streamDeck.logger.warn(`alert: ${profile} did not appear on ${device.name} — the profile is not installed`);
				}
			}, 2000).unref?.();
		}
	}

	/** Sends every deck showing the alert back to the profile it came from. */
	public async dismissAlert(): Promise<void> {
		const devices = [...this.#alerting];
		this.#alerting.clear();
		for (const id of devices) {
			// No profile name: Stream Deck returns to the one shown before.
			await streamDeck.profiles.switchToProfile(id).catch((error: Error) =>
				streamDeck.logger.warn(`alert: could not switch back: ${error.message}`),
			);
		}
	}

	/**
	 * Notes that a device left the alert profile some other way — the user
	 * picked another profile — so it is not switched "back" later.
	 * @param deviceId The device.
	 */
	public alertLeft(deviceId: string): void {
		// Our own switch back clears the set first; anything still listed here
		// was left by hand. Defer a tick, since the last key's disappearance is
		// what tells.
		setTimeout(() => {
			const stillShowing = [...streamDeck.actions].some(
				(unit) => unit.manifestId === "io.github.claude-deck.plugin.alert" && unit.device.id === deviceId,
			);
			if (!stillShowing) {
				this.#alerting.delete(deviceId);
			}
		}, 250).unref?.();
	}

	/**
	 * Brings the token history up to date, at most once a minute.
	 *
	 * The transcripts live wherever Claude Code runs; every session the deck
	 * has seen says where, so their `projects` folders are the ones read.
	 */
	public refreshHistory(): void {
		if (!this.#bridge) {
			return;
		}

		const roots = new Set<string>([join(claudeHome(), "projects")]);
		for (const session of this.store.list()) {
			if (session.transcriptPath) {
				// <projects>/<project>/<session>.jsonl
				const root = localizePath(posix.dirname(posix.dirname(session.transcriptPath.replace(/\\/g, "/"))), session.wslDistro);
				if (root) {
					roots.add(root);
				}
			}
		}

		void this.history.refresh([...roots]).then((changed) => {
			if (changed) {
				this.emit("change");
			}
		});
	}

	/**
	 * Re-points the installed hooks when the URL they carry has gone stale.
	 * @returns The new URL when it changed, otherwise `undefined`.
	 */
	public async reconcile(): Promise<string | undefined> {
		if (!this.#settings.hooksInstalled || !this.#bridge?.listening) {
			return undefined;
		}

		try {
			const location = await this.location();
			const [installed, wanted, relay] = await Promise.all([
				installedHookUrl(location.settingsPath),
				this.hookBaseUrl(),
				statusLineInstalled(location.settingsPath),
			]);

			// An install from before plan limits existed, or one where the user
			// replaced the status line since: bring the relay in line too.
			const relayStale = relay !== Boolean(this.#settings.planLimits);

			if (!installed || (installed === wanted && !relayStale)) {
				return undefined;
			}

			streamDeck.logger.info(
				installed === wanted ? "status line relay out of date; reinstalling" : `hook url moved from ${installed} to ${wanted}; reinstalling`,
			);
			await this.connect();
			return wanted;
		} catch (error) {
			streamDeck.logger.warn(`reconcile failed: ${(error as Error).message}`);
			return undefined;
		}
	}

	/** Takes on settings written by a property inspector without echoing them back. */
	async #adopt(incoming: Partial<GlobalSettings>): Promise<void> {
		const merged = { ...this.#settings, ...incoming };
		if (JSON.stringify(merged) === JSON.stringify(this.#settings)) {
			return;
		}

		const compactChanged = merged.autoCompactK !== this.#settings.autoCompactK;
		const limitsChanged = merged.planLimits !== this.#settings.planLimits;
		const ghostsChanged = merged.ghosts !== this.#settings.ghosts;
		this.#settings = merged;

		if (ghostsChanged) {
			setGhosts(merged.ghosts !== false);
			this.emit("change");
		}

		// The status line relay is written alongside the hooks, so re-run that.
		if (limitsChanged && this.#settings.hooksInstalled) {
			await this.connect().catch((error) =>
				streamDeck.logger.warn(`could not update the status line: ${(error as Error).message}`),
			);
		}

		if (compactChanged) {
			await this.applyAutoCompact();
		}

		if (this.#bridge) {
			await this.#bridge.configure({
				port: Number(this.#settings.port) || DEFAULT_PORT,
				exposeToWsl: this.#settings.exposeToWsl,
				token: this.#settings.token,
				deckApprovals: this.#approvers.size > 0 && this.#settings.deckApprovals,
				approvalTimeoutMs: Number(this.#settings.approvalTimeoutSec || 45) * 1000,
				notifyTerminal: this.#settings.notifyTerminal,
			});
		}

		this.emit("change");
	}

	/** Persists a settings patch and re-applies anything it affects. */
	public async update(patch: Partial<GlobalSettings>): Promise<void> {
		this.#settings = { ...this.#settings, ...patch };
		await streamDeck.settings.setGlobalSettings(this.#settings);

		if (this.#bridge) {
			await this.#bridge.configure({
				port: this.#settings.port,
				exposeToWsl: this.#settings.exposeToWsl,
				token: this.#settings.token,
				deckApprovals: this.#approvers.size > 0 && this.#settings.deckApprovals,
				approvalTimeoutMs: this.#settings.approvalTimeoutSec * 1000,
				notifyTerminal: this.#settings.notifyTerminal,
			});
		}

		this.emit("change");
	}

	public registerApprover(context: string): void {
		this.#approvers.add(context);
		this.#syncApprovalMode();
	}

	public unregisterApprover(context: string): void {
		this.#approvers.delete(context);
		this.#syncApprovalMode();
	}

	/**
	 * Holding a permission request open suppresses Claude Code's own prompt, so
	 * only do it while an Approve key is actually visible to answer it.
	 */
	#syncApprovalMode(): void {
		if (!this.#bridge) {
			return;
		}

		const wanted = this.#approvers.size > 0 && this.#settings.deckApprovals;
		if (wanted !== this.#bridge.options.deckApprovals) {
			void this.#bridge.configure({ ...this.#bridge.options, deckApprovals: wanted });
		}
	}

	/** The URL Claude Code should POST hooks to, given where Claude Code runs. */
	public async hookBaseUrl(): Promise<string> {
		const { port, exposeToWsl, distro } = this.#settings;
		if (!exposeToWsl) {
			return `http://127.0.0.1:${port}`;
		}

		if (await hasMirroredNetworking()) {
			return `http://127.0.0.1:${port}`;
		}

		const host = await wslHostAddress(distro || undefined);
		return `http://${host ?? "127.0.0.1"}:${port}`;
	}

	/**
	 * Where this machine's Claude Code keeps its configuration.
	 * @param runner Overrides the plugin-wide runner, for a single action.
	 * @param distro Overrides the plugin-wide WSL distribution.
	 * @returns The resolved location.
	 */
	public location(runner?: Runner, distro?: string): Promise<ClaudeLocation> {
		return resolveClaudeLocation(
			runner || this.#settings.runner,
			distro || this.#settings.distro || undefined,
			this.#settings.settingsOverride,
		);
	}

	/** Writes the hooks into Claude Code's settings and records that we did. */
	public async connect(): Promise<string> {
		const location = await this.location();

		// Reaching a Windows-side bridge from inside WSL needs a non-loopback bind.
		if (location.kind === "wsl" && !this.#settings.exposeToWsl) {
			await this.update({ exposeToWsl: true });
		}

		const path = await installHooks({
			baseUrl: await this.hookBaseUrl(),
			token: this.#settings.token,
			approvalTimeoutSec: this.#settings.approvalTimeoutSec,
			deckApprovals: this.#settings.deckApprovals,
			idleWake: this.#settings.idleWake,
			location,
			nodeCommand:
				this.#settings.idleWake || this.#settings.planLimits ? await resolveNodeCommand(location) : undefined,
			planLimits: this.#settings.planLimits,
		});

		await this.update({ hooksInstalled: true, distro: location.distro ?? this.#settings.distro });
		await this.applyAutoCompact();
		return path;
	}

	/**
	 * The auto-compact window Claude Code will use, when the deck manages it.
	 * @returns Tokens, `"auto"`, or `undefined` when the user's own setting stands.
	 */
	public autoCompactWindow(): number | "auto" | undefined {
		const raw = String(this.#settings.autoCompactK ?? "").trim();
		if (!raw) {
			return undefined;
		}
		if (raw === "auto") {
			return "auto";
		}
		const thousands = Number(raw);
		return Number.isFinite(thousands) && thousands > 0 ? thousands * 1000 : undefined;
	}

	/** Writes the chosen auto-compact window into Claude Code's settings. */
	public async applyAutoCompact(): Promise<void> {
		const window = this.autoCompactWindow();
		if (window === undefined || !this.#settings.hooksInstalled) {
			return;
		}

		try {
			const path = (await this.location()).settingsPath;
			const written = await setAutoCompactWindow(path, window);
			streamDeck.logger.info(`autoCompactWindow=${written} written to ${path}`);
		} catch (error) {
			streamDeck.logger.warn(`could not set autoCompactWindow: ${(error as Error).message}`);
		}
	}

	public async disconnect(): Promise<string> {
		const location = await this.location();
		const path = await uninstallHooks(location.settingsPath, location);
		await this.update({ hooksInstalled: false });
		return path;
	}

	/** Bridge details helper scripts need when they are written on demand. */
	public async helperContext(): Promise<{ baseUrl: string; token: string }> {
		return { baseUrl: await this.hookBaseUrl(), token: this.#settings.token };
	}

	/** Snapshot for the property inspectors. */
	public async diagnostics(): Promise<Record<string, unknown>> {
		const location = await this.location().catch(() => undefined);

		return {
			listening: this.#bridge?.listening ?? false,
			error: this.#bridge?.lastError,
			baseUrl: await this.hookBaseUrl(),
			hooksInstalled: this.#settings.hooksInstalled,
			settingsPath: location?.settingsPath,
			locationKind: location?.kind,
			sessions: this.store.summaries(),
			distros: (await listWslDistros()).map((d) => d.name),
			nodeCommand: location ? await resolveNodeCommand(location).catch(() => undefined) : undefined,
			detected: (await detectClaudeLocations().catch(() => [])).map((c) => ({
				kind: c.kind,
				distro: c.distro ?? null,
				settingsPath: c.settingsPath,
			})),
			reachable:
				location && this.#settings.hooksInstalled
					? await probeReachability(location, await this.hookBaseUrl(), helperPath(location, "reach")).catch(
							() => "unknown",
						)
					: "unknown",
			platform: process.platform,
			settings: this.#settings,
		};
	}
}

export const runtime = new Runtime();
