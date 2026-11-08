# Contributing

Issues and pull requests are welcome.

## Getting set up

```bash
npm install
npm run build
npx @elgato/cli link io.github.claude-deck.plugin.sdPlugin
npm run watch
```

`npm run watch` rebuilds on every change and restarts the plugin inside Stream Deck.

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run validate
```

## Testing against a real Claude Code session

The bridge can be driven without Stream Deck. Start it on a free port, point Claude Code at it with
inline settings, and watch the events arrive:

```bash
npx tsc -p tsconfig.test.json && cp .test-build-package.json .test-build/package.json
node -e '
  import("./.test-build/bridge/server.js").then(async ({ Bridge }) => {
    const bridge = new Bridge({ port: 38275, exposeToWsl: false, token: "dev", deckApprovals: false, approvalTimeoutMs: 5000 });
    bridge.on("log", console.log);
    bridge.on("change", () => console.log(bridge.store.summaries()));
    await bridge.start();
  });
'
```

```bash
claude -p "say hi" --settings '{"hooks":{"Stop":[{"hooks":[{"type":"http","url":"http://127.0.0.1:38275/hook","headers":{"X-Claude-Deck-Token":"dev"},"onFailure":"continue"}]}]}}'
```

## Conventions

- TypeScript, tabs, no default exports except the Stream Deck SDK's own.
- Every exported symbol gets a doc comment explaining *why*, not *what*.
- Hooks must always be installed with `onFailure: "continue"` — a closed Stream Deck must never block
  someone's Claude Code session.
