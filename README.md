# dsh-token-counter

A global DSH plugin that shows a **realtime token counter** right after the blue
"深度思考 / 深度求索" (deep-thinking) indicator, plus **per-operation token usage**
after each completed step. It is global: once enabled, every conversation gets it.

## Features

1. **Live in / out token counter** — after the deep-thinking indicator, a
   "华光划过" (shimmer sweep) badge shows the streaming token count.
   - `in N token` = input tokens, `out N token` = output tokens.
   - Input tokens are authoritative (from the model's `usage`); the streaming
     output count is a client-side estimate (CJK glyph ≈ 1 token, latin ≈ 4 chars/token),
     then snaps to the authoritative value when the stream settles.
2. **Display mode (configurable)** — `merged` (default) or `split`.
   - `merged`: shows only `in …` during the input phase and only `out …` while
     generating (the phase flips as soon as the first output token streams).
   - `split`: always shows `in … · out …` together.
3. **In / out visibility (configurable)** — independent switches to show/hide
   the input and output counters (both on by default).
4. **Per-operation "use N token" (configurable)** — after each completed
   operation ("已完成思考", "已完成命令", …) a `use N token` label appears, styled to
   match that row, showing the turn's cumulative input+output tokens. One switch
   toggles it.
5. All options are configurable from the DSH **Plugins → Token 计数器** page.

## Install

```bash
# 1. pack the plugin
cd packages/dsh-token-counter
pnpm pack

# 2. install into the desktop profile
dsh plugin --profile desktop add ./dsh-token-counter-1.0.0.tgz
# (or manually: add the tarball to the profile's package.json dependencies and
#  append "dsh-token-counter" to dsh.profile.bundles, then `pnpm install`)

# 3. restart DSH
```

## Usage

1. Open any conversation and send a message.
2. While the model is thinking/streaming, the counter appears after the
   "深度思考" indicator and counts up in real time.
3. When the answer completes, each "已完成…" operation row shows `use N token`.
4. Open **设置 → 插件 → Token 计数器** to switch merged/split mode and toggle the
   input / output / per-operation displays.

## How it works

- The browser half subscribes to the DSH client `sessions` service and the active
  (main-view) session's `binding.eventSource`.
- It counts `text-delta` / `reasoning-delta` stream chunks as they arrive and
  reads authoritative `usage` from the `usage` chunk / `assistant/message` event.
- It injects a DOM badge into the running indicator (there is no slot around it),
  and `use N token` labels into closed process-group headers.

## Package layout

- `lib/index.js` — host half: schemastery `Config` (the configurable options) + `apply`.
- `lib/client.js` — browser half via `window.__ModuleLoader__.load`.
- `cordis.patch.yml` — registers the plugin profile entry.
- `package.json` — `dsh.client = { platform: "web", inject: [...] }`.

## Develop / test

```bash
node test/run-tests.mjs   # mocked-browser unit tests (all features)
```
