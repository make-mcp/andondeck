# Troubleshooting

Open the **Connect Claude Code** key's settings first — the panel at the top reports the bridge state,
whether hooks are installed, the exact URL and settings file in use, and every session that has reported
in. Most answers are there.

## The status key says "No session"

The bridge is up but no hook has arrived yet.

- Start or restart Claude Code. Hooks are read when a session starts; an already-running session will not
  pick them up.
- Check the **Settings** path in the panel. On Windows it must point inside your WSL distribution if that
  is where Claude Code runs — `\\wsl.localhost\<distro>\home\<you>\.claude\settings.json`. If it shows a
  `C:\Users\…` path instead, set **Runner** to *Run claude inside WSL* and press **Install hooks** again.
- Confirm the hooks landed:

  ```bash
  grep -c claude-deck ~/.claude/settings.json
  ```

- Watch Claude Code try to call them:

  ```bash
  claude --debug 2>&1 | grep -i hook
  ```

## The status key says "Port blocked"

Something else owns the port. Pick another one under **Bridge → Port**, then press **Install hooks**
again so the hook URLs match.

```bash
# Windows
netstat -ano | findstr 38274
# macOS
lsof -i :38274
```

## Hooks are installed but nothing arrives (Windows + WSL)

Almost always the network boundary. From inside WSL:

```bash
curl -s http://$(ip route | awk '/^default/{print $3}'):38274/health
```

- No response: Windows Firewall is blocking the inbound connection. Allow the Stream Deck app, or switch
  WSL to mirrored networking and let loopback do the work:

  ```ini
  # %USERPROFILE%\.wslconfig
  [wsl2]
  networkingMode=mirrored
  ```

  Then `wsl --shutdown` and press **Install hooks** again.
- `{"error":"bad token"}`: the hooks were written by a different installation. Press **Install hooks**
  again.
- The gateway address changes when WSL restarts. Re-run **Install hooks** after `wsl --shutdown`, or use
  mirrored networking to avoid the problem entirely.

## Queued prompts never run

- If the session is **working**, the prompt goes in when the turn ends. That is normal.
- If the session is **idle**, delivery needs the idle-wake helper. Check **Connect Claude Code → Idle
  wake** is on, then press **Install hooks** again — the helper is only generated during install.
- Confirm the helper exists and `node` is on `PATH` where Claude Code runs:

  ```bash
  ls ~/.claude/claude-deck/idle-wake.mjs && node --version
  ```

## Approve / Deny says "Nothing to answer" while the terminal is asking

Requests are only held for the deck while an Approve key is on screen. If the key is on another page or
profile, Claude Code asks in the terminal instead — by design.

Also check **Connect Claude Code → Approvals** is enabled, and that the request has not already timed out
(**Wait up to**, default 45 s).

## Run Task fails immediately

The key reports what went wrong. The usual causes:

- `Could not run claude` — the runner is wrong. Switch between *Run claude directly* and *Run claude
  inside WSL* in the action's settings.
- Permission errors — a headless run has no one to ask. Give it `--allowedTools Read,Grep` under **Extra
  arguments**, or set **Permissions** to *Accept edits*.

## Removing everything

Press **Remove hooks** on the Connect key. It strips only the entries Claude Deck owns and leaves the rest
of your `settings.json` untouched. A copy of the previous file is kept as `settings.json.claude-deck.bak`.

The generated helper at `~/.claude/claude-deck/idle-wake.mjs` is safe to delete by hand.

## Plugin logs

```
# Windows
%APPDATA%\Elgato\StreamDeck\Plugins\io.github.claude-deck.plugin.sdPlugin\logs
# macOS
~/Library/Application Support/com.elgato.StreamDeck/Plugins/io.github.claude-deck.plugin.sdPlugin/logs
```

## "Claude reaches it: NO"

The setup panel runs a real connection test from Claude Code's side. A `NO` means the bridge is listening
but Claude Code cannot open a socket to it — on Windows that is almost always the firewall blocking the
inbound connection from WSL. Allow the Stream Deck app, or switch WSL to mirrored networking so the
traffic never leaves loopback.

## Detection picked the wrong Claude

The panel lists what it found under **Also found**. If the wrong one is in use:

- set **Runner** to *Run claude directly* or *Run claude inside WSL*, and pick the **Distribution**; or
- for anything unusual (`CLAUDE_CONFIG_DIR`, a portable install), put the exact path to `settings.json`
  into **Advanced → Settings file**.

Press **Install hooks** afterwards so the hooks land in the right file.

## "Node for hooks" is empty

Only matters for idle wake. The generated wrapper searches `PATH`, nvm, fnm, volta, bun, asdf, Homebrew
and the usual system locations at run time, so an empty value here is not fatal — but if idle wake never
fires, check that `node` exists somewhere Claude Code's shell can reach.
