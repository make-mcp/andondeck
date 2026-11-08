/** Human-readable one-liners for tool calls shown on a 72x72 key. */

const MAX = 120;

function clamp(value: string, max = MAX): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function tail(path: string, segments = 2): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.slice(-segments).join("/") || path;
}

/**
 * Describes a tool call tersely enough to fit on a key.
 * @param toolName Name of the tool Claude wants to run.
 * @param input Tool arguments as reported by the hook.
 * @returns A short description, e.g. `Bash: npm test`.
 */
export function summarizeTool(toolName: string, input: Record<string, unknown> = {}): string {
	const str = (key: string): string | undefined => (typeof input[key] === "string" ? (input[key] as string) : undefined);

	switch (toolName) {
		case "Bash": {
			return clamp(`Bash: ${str("command") ?? ""}`);
		}
		case "Edit":
		case "Write":
		case "NotebookEdit": {
			const file = str("file_path") ?? str("notebook_path") ?? "";
			return clamp(`${toolName}: ${tail(file)}`);
		}
		case "Read": {
			return clamp(`Read: ${tail(str("file_path") ?? "")}`);
		}
		case "WebFetch": {
			try {
				return clamp(`Fetch: ${new URL(str("url") ?? "").host}`);
			} catch {
				return clamp(`Fetch: ${str("url") ?? ""}`);
			}
		}
		case "WebSearch": {
			return clamp(`Search: ${str("query") ?? ""}`);
		}
		case "Agent": {
			return clamp(`Agent: ${str("description") ?? str("subagent_type") ?? ""}`);
		}
		default: {
			if (toolName.startsWith("mcp__")) {
				const [, server, tool] = toolName.split("__");
				return clamp(`${server}: ${tool ?? ""}`);
			}

			const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
			return clamp(first ? `${toolName}: ${first}` : toolName);
		}
	}
}

/** Shortens free text for a key title, keeping whole words where it can. */
export function keyLabel(text: string, max = 42): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) {
		return flat;
	}

	const cut = flat.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
