# dsh-token-counter

一个全局 DSH 插件：在蓝色「深度思考 / 深度求索」指示器后面实时显示 token 计数器，并在每个已完成的操作后显示该操作的 token 消耗。插件是全局的——启用后所有对话都会生效。

## 功能

1. **实时 in / out token 计数器** —— 在深度思考指示器后，带「华光划过」特效的徽标实时显示 token 数；特效与配色直接复用 DSH 官方「深度思考」文案的扫光实现，与整行文字浑然一体。
   - `in N token` = 输入 token，`out N token` = 输出 token。
   - 输入数字取宿主自身为本次请求定标的提示词规模（`contextPressure` 投影），因此在输入阶段即为实时值，无需等待供应商上报 `usage`；供应商一旦上报 `inputTokens` 就以权威值优先；两者都未就绪时沿用上一次的输入值。
   - 流式输出数字为客户端估算
     （中文/全角字符 ≈ 1 token，拉丁字符 ≈ 4 字符/token），流结束时自动校准为权威值。
2. **显示模式（可配置）** —— `合并模式`（默认）或 `分开模式`。
   - 合并模式：两段文字互相替换而非叠加——输入阶段只显示 `in …`，输出阶段只显示 `out …`（第一条输出 token 到来即切换）。
   - 分开模式：整轮始终同时显示 `in … · out …`。
3. **in / out 显示开关（可配置）** —— 独立开关控制输入、输出计数器的显示（默认都打开）。
4. **每个操作后的 `use N token`（可配置）** —— 每个已完成操作（「已完成思考」「已完成命令」等）
   后面显示 `use N token`，样式与该行文字统一，展示**该操作自身那一步**消耗的 token
   （输入+输出，若供应商上报了 `totalTokens` 则以其为准），绝不是一整条回复的累计值。一个开关控制其显隐。
5. 所有选项共有四个入口：**设置 → Token 计数器**、**设置 → 内置插件** 里的同名标签页、
   **插件** 面板中本插件页面里的配置区，以及该面板「官方」分组里的「Token 计数器」卡片。

## 安装

```bash
# 1. 打包插件
cd packages/dsh-token-counter
pnpm pack

# 2. 安装到 desktop 配置
dsh plugin --profile desktop add ./dsh-token-counter-<version>.tgz
# （或手动：把 tarball 加入配置的 package.json dependencies，
#   并把 "dsh-token-counter" 追加到 dsh.profile.bundles，然后 `pnpm install`）

# 3. 重启 DSH
```

## 使用方法

1. 打开任意对话并发送消息。
2. 模型思考/输出时，计数器出现在「深度思考」指示器后并实时累加。
3. 回答完成后，每个「已完成…」操作行后显示 `use N token`（该行自己那一步的用量）。
4. 打开 **设置 → Token 计数器** 切换合并/分开模式，以及输入/输出/每操作显示开关。
   同一份表单还可从 **设置 → 内置插件** 的同名标签页、**插件** 面板中本插件页面里的配置区
   （「dsh-token-counter」→ 配置），以及该面板「官方」分组里的「Token 计数器」卡片打开。
   若表单显示「该插件当前未加载，暂时无法配置」，说明宿主端未挂载：请先用
   `dsh --profile desktop --dump-config`（或查看配置目录的 `cordis.patch.yml`）确认后再提 issue。

## 实现原理

- 浏览器端订阅 DSH 客户端 `sessions` 服务，以及当前（主视图）会话的 `binding.eventSource`。
- 实时统计 `text-delta` / `reasoning-delta` 流式分片，输入数字读宿主的 `contextPressure` 投影，权威 usage 来自 `usage` 分片 / `assistant/message` 事件（按 turn + step 记录）。
- 通过 DOM 向运行指示器注入徽标（该处没有 slot）；每个已完成的操作行按文档顺序认领其对应步骤的用量，因此显示的是该操作自己的 token 数。

## 包结构

- `lib/index.js` —— 宿主端：schemastery `Config`（可配置项）+ `apply`。
- `lib/client.js` —— 浏览器端：`window.__ModuleLoader__.load`。
- `cordis.patch.yml` —— 注册插件 profile 条目。
- `package.json` —— `dsh.client = { platform: "web", inject: [...] }`。

## 开发 / 测试

```bash
node test/run-tests.mjs   # 模拟浏览器的单元测试（覆盖全部功能）
```
