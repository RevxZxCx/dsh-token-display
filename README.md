# dsh-token-counter

Global DSH plugin that appends a realtime **`N token`** counter right after the
blue "深度思考 / 深度求索" (deep-thinking) indicator in the chat view, updating
live as the model streams.

## How it works

- Subscribes to the DSH client `sessions` service and, for the active (main-view)
  session, its `binding.eventSource`.
- Counts `text-delta` / `reasoning-delta` stream chunks as they arrive.
- Because the provider sends **text** deltas (not per-token counts), the rolling
  number is a client-side estimate: CJK/full-width glyphs ≈ 1 token each,
  ASCII/latin glyphs ≈ 4 chars/token.
- Injects a styled `<span data-dsh-token-counter>N token</span>` inside the
  running indicator via DOM, so it mounts/unmounts with the indicator.

## Package shape (matches widget-dock@1.0.2)

- `lib/index.js` — host (node) half: `export function apply() {}`
- `lib/client.js` — browser half via `window.__ModuleLoader__.load` (inject `["sessions"]`)
- `cordis.patch.yml` — `- insert: [{id: dsh-token-counter, name: dsh-token-counter}]`
- `package.json` `dsh.client = { platform: "web", inject: [...] }`, `exports["./client"]` → `lib/client.js`
