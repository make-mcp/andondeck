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
| **Queue Prompt** | Stores a prompt locally and hands it over the moment the current turn ends. Can queue whatever you last copied, so an error message goes from clipboard to Claude in one press. |
| **Queue Control** | Browse, promote, drop or clear queued prompts. On a Stream Deck +, rotate to scroll. |
| **Approve / Deny** | Answers Claude Code permission requests from the deck, with an optional confirm-twice guard. |
| **Prompt / Slash Command** | One-tap prompts and slash commands — `/compact`, `/review`, or anything you write. |
| **Session Switcher** | Pin which session the deck controls, or cycle through everything that is open. |
| **Run Task** | A one-shot `claude -p` run in the background. Never touches your open session. |
| **Usage & Timer** | Turn timer, tool calls, token counts and context pressure. |
| **Autopilot** | Approves tool calls for a set stretch of time, then switches itself back off. |
| **Stop Claude** | Emergency brake: blocks every further tool call so Claude winds down and reports back. |
| **Model** | Shows the session's model and switches it at the next turn boundary. |
| **Connect Claude Code** | One-time setup. Installs the hooks, shows bridge health and every setting. |

## Autopilot and the brake

Two things only the hook bridge can do.

**Autopilot** answers `PreToolUse` with `allow` for a window you choose — read-only tools, or everything.
It differs from a permission mode in the ways that matter when you are not watching: it is armed from a
key, the key shows what is armed and counts the window down, and one press turns it off.

**Stop Claude** is the brake. No hook can interrupt a turn already in flight, but `PreToolUse` can deny
everything that comes next, which stops the agent touching anything further and makes it wind down and
report where it got to. The brake outranks autopilot — arming one cannot defeat the other — and it
releases itself once the turn ends.

## Ready-made profiles

The plugin ships a layout for every supported device, designed for its grid rather than cropped from a
bigger one — Stream Deck, Mini, XL, + (with the dials wired to the queue, session and usage) and Neo.
Pick one under **Profiles → +** in the Stream Deck app; nothing is installed or switched automatically.

## Install

### From source

Requires Node.js 20.5+ (24+ recommended) and Stream Deck 6.9+.

```bash
git clone https://github.com/make-mcp/claude-deck.git
cd claude-deck
npm install
npm run build
npm run link
```

`npm run link` also works when the repository lives inside WSL but Stream Deck runs on the Windows host,
which the Elgato CLI's own `link` cannot do.

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

## Working across installs

Hooks and `wsl.exe` both spawn commands *without* a login shell, and Ubuntu's `.bashrc` returns early when
it is not interactive — so a `node` or `claude` installed through nvm, fnm, volta or bun is invisible to a
bare command name, even though it works perfectly in your own terminal. Claude Deck therefore:

- **generates small shell helpers** next to your Claude Code config that locate the executable at run time,
  covering PATH, nvm, fnm, volta, bun, asdf, Homebrew and the native installer;
- **never passes shell source through `wsl.exe`** — its argument parsing mangles quoting badly enough to
  blank out `$HOME`. Scripts are delivered as files and only plain arguments cross the boundary;
- **detects where Claude Code actually lives** rather than assuming, ranking a native install against every
  WSL distribution by which was used most recently;
- **repairs itself** when the WSL gateway address moves or the bridge lands on a different port, re-pointing
  the installed hooks instead of going quietly dead;
- **reports reachability** in the setup panel, so a blocking firewall is visible rather than silent.

If detection still picks the wrong install — `CLAUDE_CONFIG_DIR`, an unusual layout — point
**Connect Claude Code → Advanced → Settings file** at the right `settings.json`.

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

## Notifications

Terminal notifications are opt-out: when Claude needs permission or a turn fails, the hook response asks
your terminal to raise a notification (OSC 9), which Windows Terminal, iTerm2, ConEmu and others honour.

## Privacy

Everything stays on your machine. The plugin talks to `127.0.0.1` (or the WSL gateway), stores queued
prompts in memory only, and never sends anything to a remote service. It does not read or modify your
Claude credentials. Session transcripts are read only to sample token counters, and only when they are
reachable on the local filesystem.

## Development

```bash
npm run watch      # rebuild and hot-reload into Stream Deck
npm test           # bridge, hook-installation and executable-location tests
npm run validate   # Elgato manifest validation
npm run link       # link the built plugin into Stream Deck (works from WSL too)
npm run profiles   # regenerate the bundled device profiles
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
