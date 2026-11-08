# Claude Deck

Control [Claude Code](https://claude.com/claude-code) from your Elgato Stream Deck. Free, open source, MIT.

See what Claude is doing, queue the next prompt without interrupting the current turn, answer permission
requests with one key, switch between projects, fire off background tasks, and keep an eye on context
pressure — all from the deck.

> **Status:** 0.1.0. Verified against Claude Code 2.1.319 and Stream Deck 7.4. Not yet on Elgato
> Marketplace; build it yourself with the steps below.

## How it works

Claude Code supports **HTTP hooks**: it POSTs lifecycle events to a URL, and the JSON it gets back is the
hook's decision. Claude Deck runs that endpoint inside the Stream Deck plugin itself.

```
Claude Code                              Stream Deck plugin
     │                                          │
     ├─ SessionStart / UserPromptSubmit ───────►│  status, project, model
     ├─ PreToolUse / PostToolUse ──────────────►│  current tool, counters
     │                                          │
     ├─ PermissionRequest ─────────────────────►│  held open while an
     │◄──────── { behavior: "allow" } ──────────┤  Approve key is on screen
     │                                          │
     ├─ Stop ──────────────────────────────────►│  queue has an entry?
     │◄──── { decision: "block", reason: … } ───┤  → Claude keeps going
     │                                          │
     └─ Stop (async, idle) ────────────────────►│  long-poll; exit 2 wakes
                                                   an idle session
```

No keystroke injection, no screen scraping, no window focus games. If Stream Deck is closed, every hook
is configured with `onFailure: "continue"` — Claude Code behaves exactly as if the plugin were not there.

## Actions

| Action | What it does |
| --- | --- |
| **Claude Status** | Live state: idle, working, waiting on you, compacting, failed. Shows the current tool, elapsed turn time and the queue count. Press to follow whichever session needs attention. |
| **Queue Prompt** | Stores a prompt locally and hands it over the moment the current turn ends. |
| **Queue Control** | Browse, promote, drop or clear queued prompts. On a Stream Deck +, rotate to scroll. |
| **Approve / Deny** | Answers Claude Code permission requests from the deck, with an optional confirm-twice guard. |
| **Prompt / Slash Command** | One-tap prompts and slash commands — `/compact`, `/review`, or anything you write. |
| **Session Switcher** | Pin which session the deck controls, or cycle through everything that is open. |
| **Run Task** | A one-shot `claude -p` run in the background. Never touches your open session. |
| **Usage & Timer** | Turn timer, tool calls, token counts and context pressure. |
| **Connect Claude Code** | One-time setup. Installs the hooks, shows bridge health and every setting. |

## Install

### From source

Requires Node.js 20.5+ (24+ recommended) and Stream Deck 6.9+.

```bash
git clone https://github.com/claude-deck/claude-deck.git
cd claude-deck
npm install
npm run build
npx @elgato/cli link io.github.claude-deck.plugin.sdPlugin
npx @elgato/cli restart io.github.claude-deck.plugin
```

### Connect

1. Drop a **Connect Claude Code** key onto your deck.
2. Press it. It writes a `hooks` block into Claude Code's `settings.json` (keeping a `.claude-deck.bak`
   copy) and leaves everything else in that file untouched.
3. Start or restart Claude Code. The status key lights up as soon as the first hook arrives.

The key's property inspector shows exactly which settings file was written, which URL the hooks use and
which sessions have reported in.

## Queueing, and the one thing to know about it

The `Stop` hook can only feed a prompt back into a turn that is **still running**. Queue something while
Claude is working and it goes in the moment the turn ends — that is the whole trick, and it needs nothing
else.

Once a session has gone idle there is nothing left to block. For that case Claude Deck can install a small
generated helper (`~/.claude/claude-deck/idle-wake.mjs`) registered as an async `Stop` hook with
`asyncRewake`. It long-polls the bridge and exits 2 with your prompt, which wakes Claude back up. It is on
by default and can be switched off in **Connect Claude Code** → *Idle wake*.

Without idle wake, a prompt queued against an idle session simply waits until you send something yourself.

## Windows and WSL

If Claude Code runs inside WSL — the common Windows setup — two things differ, and the setup action
handles both:

- **Settings live in the distribution**, not your Windows profile. Hooks are written to
  `\\wsl.localhost\<distro>\home\<you>\.claude\settings.json`.
- **`127.0.0.1` inside WSL is not the Windows host** under the default NAT networking. The bridge binds to
  all interfaces and the hook URL uses the WSL gateway address. With
  [mirrored networking](https://learn.microsoft.com/windows/wsl/networking#mirrored-mode-networking)
  (`networkingMode=mirrored` in `.wslconfig`) plain loopback is used instead.

Every request carries a random per-installation token; requests without it are rejected with 401.

On macOS none of this applies — Claude Code is reached natively on loopback.

## Privacy

Everything stays on your machine. The plugin talks to `127.0.0.1` (or the WSL gateway), stores queued
prompts in memory only, and never sends anything to a remote service. It does not read or modify your
Claude credentials. Session transcripts are read only to sample token counters, and only when they are
reachable on the local filesystem.

## Development

```bash
npm run watch      # rebuild and hot-reload into Stream Deck
npm test           # bridge and hook-installation tests
npm run validate   # Elgato manifest validation
npm run pack       # build a .streamDeckPlugin into dist/
```

The test suite drives the bridge over real HTTP with the same payloads Claude Code sends, including the
`Stop` → `decision: "block"` chaining and the permission round trip.

See [docs/architecture.md](docs/architecture.md) for the internals and
[docs/troubleshooting.md](docs/troubleshooting.md) when something does not light up.

## Licence

MIT. See [LICENSE](LICENSE).

Claude and Claude Code are trademarks of Anthropic. This project is not affiliated with Anthropic or
Elgato.
