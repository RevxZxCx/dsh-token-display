# Where Did My Tokens Go?

*我的 token 都去哪了？* A global DSH plugin that shows a **realtime token counter** right after the blue
"深度思考 / 深度求索" (deep-thinking) indicator, plus **per-operation token usage**
after each completed step. It is global: once enabled, every conversation gets it.

## Features

1. **Live in / out token counter** — after the deep-thinking indicator, a
   "华光划过" (shimmer sweep) badge shows the streaming token count, painted with
   the platform's own shimmer so it reads as part of the same sentence.
   - `in N token` = input tokens, `out N token` = output tokens.
   - **Unit scaling (auto by default)** — numbers render as `K` (1e3), `M`
     (1e6), `G` (1e9) or `T` (1e12) by magnitude (`1866 → 1.9K`,
     `2 500 000 → 2.5M`); below 1000 the raw number shows. A rounding that
     would print `1000K` promotes to `1M` instead. Each site (in / out / use)
     can instead LOCK one unit in its gear menu and then always scales by it.
   - The input count is the number the harness itself prices the prompt with
     (its `contextPressure` projection), so it is live during the input phase and
     does not wait for the provider's `usage`. When the provider does report
     `inputTokens`, that authoritative figure takes precedence; when neither is
     available yet, the last known input is reused.
   - The streaming output count is a client-side estimate (CJK glyph ≈ 1 token,
     latin ≈ 4 chars/token), then snaps to the authoritative value when the
     stream settles.
2. **Display mode (configurable)** — `merged` (default) or `split`.
   - `merged`: the label swaps rather than stacking — only `in …` during the
     input phase, only `out …` while generating (the phase flips as soon as the
     first output token streams).
   - `split`: always shows `in … · out …` together, for the whole turn.
3. **In / out visibility (configurable)** — independent switches to show/hide
   the input and output counters (both on by default). Each of the three
   switches carries a **gear button**: clicking it drops open a per-site editor
   with **font size** (0/empty = follow the interface text), **color** (a native
   picker plus a "follow theme" reset) and **unit** (auto / K / M / G / T).
   Settings are staged in the same form and saved together with everything else.
4. **Per-operation "use N token" (configurable)** — after each completed
   operation ("已完成思考", "已完成命令", …) a `use N token` label appears, styled to
   match that row, showing the tokens **that operation's own step** consumed
   (input + output, or the provider's `totalTokens` when it reports one) — never
   the whole reply's total. One switch toggles it; its own gear menu styles it.
5. All options are configurable from three places: **设置 → Token 计数器**
   (Settings → Token Counter), the configuration section on this bundle's page
   in the **插件 / Plugins** panel, and the card in that panel's
   **官方 / Official** group.
6. **Visual settings UI** — a light white/grey, adaptive two-pane layout: merged
   and split each get a **preview card that recreates the real transcript scene**
   (a "Command finished · use N token" row and the deep-thinking badge with the
   shimmer sweep, all with fake data). Hovering a card animates the numbers
   (in climbs to its cap, pauses, then out climbs); clicking it switches the
   display mode; and the in / out / use toggles update both cards live — turn
   `in` off and both cards drop the in segment immediately. The gear menus'
   unit/font/color choices are reflected in the preview cards before saving.

## Install

```bash
# 1. pack the plugin
cd packages/dsh-where-did-my-tokens-go
pnpm pack

# 2. install into the desktop profile
dsh plugin --profile desktop add ./dsh-where-did-my-tokens-go-<version>.tgz
# (or manually: add the tarball to the profile's package.json dependencies and
#  append "dsh-where-did-my-tokens-go" to dsh.profile.bundles, then `pnpm install`)

# 3. restart DSH
```

## Usage

1. Open any conversation and send a message.
2. While the model is thinking/streaming, the counter appears after the
   "深度思考" indicator and counts up in real time.
3. When the answer completes, each "已完成…" operation row shows `use N token`
   for that operation's own step.
4. Open **设置 → Token 计数器**: hover a preview card to watch the numbers
   animate, click it to switch merged/split, and use the in / output / per-op
   toggles — the cards update in lockstep. Save when you are done. The same
   form is also reachable as the configuration section on this bundle's page
   in the **插件 / Plugins** panel
   ("dsh-where-did-my-tokens-go" → 配置), and as the "Token 计数器" card in that panel's
   "官方 / Official" group.
   If the settings form reports "This plugin is not loaded, so it cannot be
   configured right now", the host half is not mounted — run
   `dsh --profile desktop --dump-config` (or check the profile's
   `cordis.patch.yml`) before filing an issue.

## How it works

- The browser half subscribes to the DSH client `sessions` service and the active
  (main-view) session's `binding.eventSource`.
- It counts `text-delta` / `reasoning-delta` stream chunks as they arrive, reads
  the live input count from the harness's `contextPressure` projection, and
  records authoritative `usage` per step from the `usage` chunk /
  `assistant/message` event (keyed by turn + step).
- It injects a DOM badge into the running indicator (there is no slot around it).
  Each completed operation row is one step, so rows walked in document order
  claim the next settled step of their turn and show that step's own tokens.

## Package layout

- `lib/index.js` — host half: schemastery `Config` (the configurable options) + `apply`.
- `lib/client.js` — browser half via `window.__ModuleLoader__.load`.
- `cordis.patch.yml` — registers the plugin profile entry.
- `package.json` — `dsh.client = { platform: "web", inject: [...] }`.

## Develop / test

```bash
node test/run-tests.mjs   # mocked-browser unit tests (all features)
```
