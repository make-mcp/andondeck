import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { Bridge } from "./bridge/server.js";
import { hooksInstalled, installedHookUrl, installHooks, uninstallHooks } from "./claude/hooks.js";
import { helperPath } from "./claude/helpers.js";
import {
	detectClaudeLocations,
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

	public get settings(): Readonly<GlobalSettings> {
		return this.#settings;
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

		bridge.on("change", () => this.emit("change"));
		bridge.on("log", (message) => streamDeck.logger.info(message));
		bridge.on("notify", ({ title, body }) => this.emit("notify", { title, body }));

		this.#bridge = bridge;
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
	 * Re-points the installed hooks when the URL they carry has gone stale.
	 * @returns The new URL when it changed, otherwise `undefined`.
	 */
	public async reconcile(): Promise<string | undefined> {
		if (!this.#settings.hooksInstalled || !this.#bridge?.listening) {
			return undefined;
		}

		try {
			const location = await this.location();
			const [installed, wanted] = await Promise.all([
				installedHookUrl(location.settingsPath),
				this.hookBaseUrl(),
			]);

			if (!installed || installed === wanted) {
				return undefined;
			}

			streamDeck.logger.info(`hook url moved from ${installed} to ${wanted}; reinstalling`);
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

		this.#settings = merged;

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
			nodeCommand: this.#settings.idleWake ? await resolveNodeCommand(location) : undefined,
		});

		await this.update({ hooksInstalled: true, distro: location.distro ?? this.#settings.distro });
		return path;
	}

	public async disconnect(): Promise<string> {
		const path = await uninstallHooks((await this.location()).settingsPath);
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
