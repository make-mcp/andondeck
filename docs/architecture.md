# Architecture

## The one idea

Claude Code's hooks can be `type: "http"`. Claude POSTs the event, and **the JSON body of the response is
the hook's decision**. So the Stream Deck plugin does not need to watch files, scrape a terminal or fake
keystrokes — it just answers.

Everything in Claude Deck follows from that:

| Hook | What the bridge answers | Effect |
| --- | --- | --- |
| `Stop` | `{"decision":"block","reason":"<queued prompt>"}` | Claude does not stop; it acts on the prompt instead. |
| `PermissionRequest` | `{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}` | A key answers the permission dialog. |
| `Stop` (async helper) | long-poll, then `exit 2` with the prompt on stderr | Wakes a session that already went idle. |
| everything else | `{}` | Observation only; drives what the keys render. |

## Layout

```
src/
├── plugin.ts            registers actions, serves property-inspector data sources
├── runtime.ts           process-wide state: bridge, global settings, approver registry
├── bridge/
│   ├── server.ts        the HTTP endpoint; maps hook events onto session state
│   ├── store.ts         session registry, prompt queues, pending permissions
│   ├── summarize.ts     tool calls → one line that fits on a 72px key
│   └── types.ts         hook payloads and session shapes
├── claude/
│   ├── env.ts           locates Claude Code's config, incl. across the WSL boundary
│   ├── hooks.ts         installs / removes the hook block; generates the idle-wake helper
│   ├── headless.ts      `claude -p` runner
│   └── transcript.ts    best-effort token sampling from the session JSONL
├── actions/             one file per Stream Deck action, all extending DeckAction
└── ui/render.ts         key artwork as SVG data URIs
```

## Session state

`SessionStore` keeps one `SessionState` per `session_id`. Status transitions come straight from the hook
stream:

```
SessionStart ───────────────► idle
UserPromptSubmit ───────────► working
PreToolUse ─────────────────► working (+ current tool)
PermissionRequest ──────────► waiting
Notification(permission) ───► waiting
Notification(idle) ─────────► idle
PreCompact ─────────────────► compacting
Stop  ├─ queue non-empty ───► working   (and the queued prompt is returned)
      └─ queue empty ───────► idle
StopFailure ────────────────► error
SessionEnd ─────────────────► removed
```

Actions never address a session directly. They ask the store to `resolve()` a selector:

- empty → the pinned session, else the one that is waiting on you, else the most recent
- `id:<uuid>` → that exact session
- `project:<name>` / `cwd:<path>` → bound to a folder

That is what makes a single status key useful with four projects open.

## Permission requests

Holding a `PermissionRequest` open suppresses Claude Code's own terminal prompt — so Claude Deck only does
it while an **Approve / Deny** key is actually visible. `Runtime` tracks visible approver contexts and
flips the bridge's `deckApprovals` flag accordingly. If nothing answers within the timeout, the bridge
returns `{}` and the terminal dialog appears as normal.

## Why the queue needs two mechanisms

`Stop` fires when Claude finishes responding. Blocking it is how a queued prompt becomes the next turn —
cheap, synchronous, no extra process.

But a session that has already gone idle will not fire `Stop` again, so there is nothing left to block.
That case uses the only other door Claude Code offers: a command hook with `async: true` and
`asyncRewake: true`, which wakes Claude when it exits 2. The generated helper long-polls `POST /wait` and
exits 2 with the prompt once one appears.

The two paths cannot collide: `/wait` only delivers while the session is `idle`, and any parked waiter is
cancelled on `UserPromptSubmit` and `SessionEnd`.

## Crossing into WSL

On Windows with Claude Code inside WSL, two boundaries have to be bridged, both handled in
`claude/env.ts`:

- **Filesystem.** `resolveClaudeLocation()` asks the distribution for `$HOME` and maps it to
  `\\wsl.localhost\<distro>\…` so the plugin writes the settings file Claude Code actually reads.
  `localizePath()` does the same for transcript paths, with a shortcut for `/mnt/<drive>/…`.
- **Network.** WSL2's default NAT means loopback inside the distribution is not the Windows host. The
  bridge binds `0.0.0.0` and the hook URL points at the gateway from `ip route`. Mirrored networking is
  detected and plain loopback used instead.

A random per-installation token guards the non-loopback bind; requests without `X-Claude-Deck-Token` get
a 401.

## Rendering

Keys are drawn as SVG data URIs (`ui/render.ts`) rather than static PNGs, so a key can show a project
name, a tool, an elapsed timer and a queue badge at once. A single 1-second ticker repaints every visible
action; the bridge's `change` event repaints on top of that.
