<p align="center">
  <img src="assets/branding/banner.webp" alt="Where Did My Tokens Go?" width="100%">
</p>

<div align="center">

# token都去哪了?

  **聊天页实时 token 徽标：这一轮、每一步各花了多少，一眼看清**

  [English](README.md) · [MIT 许可证](LICENSE)

  [![许可证：MIT](https://img.shields.io/badge/许可证-MIT-green.svg)](LICENSE)
  [![npm 包](https://img.shields.io/npm/v/dsh-where-did-my-tokens-go.svg?label=npm%20%E5%8C%85)](https://www.npmjs.com/package/dsh-where-did-my-tokens-go)
  [![DSH Web Plugin](https://img.shields.io/badge/DSH%20Web-Plugin-0f766e.svg)](https://github.com/RevxZxCx/dsh-where-did-my-tokens-go)
  [![DSH 0.2.0-rc.2 实测](https://img.shields.io/badge/DSH-0.2.0--rc.2%20%E5%AE%9E%E6%B5%8B-2563eb.svg)](#安装)
</div>

> Where Did My Tokens Go? 是社区维护的 DeepSeek Harness（DSH）插件，并非 DeepSeek AI 官方产品。

本文描述 **1.6.1**。

## 功能概览

把「这一轮的 token 花到哪了」直接显示在对话流里：深度思考进行中实时计数，每个已完成的操作行标注它自己那一步的用量。插件是全局的——启用后所有对话都会生效。

- **实时 in / out token 徽标**：在蓝色「深度思考 / 深度求索」指示后，实时显示 token 数；复刻官方字体特效，与整行文字浑然一体。
  - `in N` = 输入 token，`out N` = 输出 token。
  - 输入数字取宿主自身为本次请求定标的提示词规模（`contextPressure` 投影），输入阶段即为实时值，无需等待供应商上报；供应商一旦上报 `inputTokens` 就以权威值优先；两者都未就绪时沿用上一次的输入值。输出数字在流式阶段为客户端估算（中文/全角字符 ≈ 1 token，拉丁字符 ≈ 4 字符/token），流结束时自动校准为权威值。
- **单位自适应（默认）**：数字按大小自动换算 K（1e3）、M（1e6）、G（1e9）、T（1e12），如 `1866 → 1.9K`、`2 500 000 → 2.5M`；不足 1000 显示原值；四舍五入会到 `1000K` 时自动进位为 `1M`。也可以在齿轮菜单里为某个部位**锁定单位**，选定后该部位始终按所选单位换算。
- **合并 / 分开两种显示模式（可配置）**：合并模式下标签互相替换——输入阶段只显示 `in …`，输出阶段只显示 `out …`（第一条输出 token 到来即切换）；分开模式整轮同时显示 `in … · out …`。
- **in / out / use 三个独立开关（可配置）**：分别控制输入、输出计数与每操作用量的显隐（默认全开）。每个开关各带一个**齿轮按钮**，向下展开该部位的编辑器——**字体大小**（0/留空 = 跟随界面文字）、**颜色**（原生取色器 + 「跟随界面」复位）、**单位**（自适应 / K / M / G / T）。
- **每个操作后的 `use N token`**：每个已完成操作（「已完成思考」「已完成命令」等）后显示 `use N token`，样式与该行文字统一，展示**该操作自身那一步**消耗的 token（输入+输出，若供应商上报了 `totalTokens` 则以其为准），绝不是一整条回复的累计值。
- **可视化配置界面**：白 / 浅灰浅色风格，自适应两栏布局；合并、分开各有一张**还原真实对话场景的预览卡片**（「已完成命令 use N token」操作行 + 带扫光的深度思考徽标，数据为模拟值）。悬停即演示数字增长（in 涨到上限后暂停，再涨 out），点击即切换模式，开关一变两张卡片同步更新——齿轮里的单位、字号、颜色同样即时反映。

## 界面预览

深度思考指示旁的实时徽标（分开模式）：

![聊天徽标](assets/screenshots/chat-badge.webp)

每个已完成操作行后标注自身用量：

![逐操作用量](assets/screenshots/per-op-usage.webp)

设置页的预览卡片与开关：

![设置页](assets/screenshots/settings-page.webp)

*截图取自 1.6.0 版本、运行于 DeepSeek Harness `0.2.0-rc.2`；仅保留相关面板，采用无损 WebP。*

## 安装

需要已安装并能正常运行 DeepSeek Harness。以下命令使用 `desktop` profile，请按实际环境替换。

### 让 Agent 帮你安装

把这段话发给能够操作本机终端的 Agent：

```text
请把 npm 上的 dsh-where-did-my-tokens-go 安装到我的 DSH profile，安装后确认已生效并告诉我如何重新加载。
```

### 从 npm 安装（推荐）

```bash
dsh plugin --profile desktop add dsh-where-did-my-tokens-go
```

### 从 GitHub 安装

```bash
dsh plugin --profile desktop add github:RevxZxCx/dsh-where-did-my-tokens-go
```

### 从源码安装

```bash
# 1. 打包插件
cd packages/dsh-where-did-my-tokens-go
pnpm pack

# 2. 安装到 desktop 配置
dsh plugin --profile desktop add ./dsh-where-did-my-tokens-go-<version>.tgz
# （或手动：把 tarball 加入配置的 package.json dependencies，
#   并把 "dsh-where-did-my-tokens-go" 追加到 dsh.profile.bundles，然后 `pnpm install`）

# 3. 重启 DSH
```

安装后**重启 DSH**，打开任意对话发送消息即可看到徽标。更新时重新执行安装命令。

- `1.6.1` 已在 DeepSeek Harness `0.2.0-rc.2`（desktop profile，Windows）实测运行。

## 使用说明

| 你想做什么 | 如何操作 |
| --- | --- |
| 看本轮输入 / 输出 token | 发送消息后直接看「深度思考」指示后的徽标，实时累加。 |
| 切换合并 / 分开模式 | 打开 **设置 → Token 计数器**，点击对应的预览卡片。 |
| 只保留 in 或只保留 out | 关掉另一个开关；两张预览卡片立即同步去掉该段。 |
| 看每个操作自己花了多少 | 保持 `use` 开关打开；每个「已完成…」行尾自动标注。 |
| 让大数字更好读 | 单位保持自适应；或在齿轮菜单为某部位锁定 K / M / G / T。 |
| 调整某个部位的字号 / 颜色 | 点击对应开关的齿轮，在展开的编辑器里设置；`0` / 「跟随界面」= 不覆盖。 |
| 保存前先看效果 | 齿轮改动即时反映到预览卡片；聊天徽标只在点「保存」后变化。 |

- **三个配置入口**：**设置 → Token 计数器**（设置导航中的独立条目）、**插件** 面板中本插件页面里的配置区（「dsh-where-did-my-tokens-go」→ 配置），以及该面板「官方」分组里的「Token 计数器」卡片。三处打开的是同一份表单。
- **未保存的草稿不影响聊天**：预览与齿轮编辑都在表单内暂存；徽标实际渲染只读已保存配置；「保存」写入宿主配置，「放弃」整体回退。
- **锁定单位仍逐级进位**：锁 `K` 后遇到极端大数也不会打印 `1000K`，会继续向上换算，最高 `1000T`。
- **减少动态效果**：系统开启「减少动态效果」偏好时，扫光装饰停用，数字照常显示。
- **高光带内的颜色**：扫光带经过徽标时显示该行的高光色（与官方「深度思考」同一机制）；字号与单位全程按设置生效。

## 实现原理

- 浏览器端订阅 DSH 客户端 `sessions` 服务，以及当前（主视图）会话的 `binding.eventSource`。
- 实时统计 `text-delta` / `reasoning-delta` 流式分片；输入数字读宿主的 `contextPressure` 投影；权威 usage 来自 `usage` 分片 / `assistant/message` 事件（按 turn + step 记录）。
- 通过 DOM 向运行指示器注入徽标（该处没有 slot），用两层方向相反的位移复刻平台 TextShimmer 的几何；每个已完成的操作行按文档顺序认领其对应步骤的用量。
- 宿主端以 schemastery 声明配置 schema（13 个字段，全部为可即时生效的 volatile 字段）；设置表单经 `configForms` 读写同一命名空间。

## 包结构

- `lib/index.js` —— 宿主端：schemastery `Config` + `apply`。
- `lib/client.js` —— 浏览器端：`window.__ModuleLoader__.load`。
- `cordis.patch.yml` —— 注册插件 profile 条目。
- `package.json` —— `dsh.bundle` + `dsh.client = { platform: "web", inject: [...] }`。

## 开发 / 测试

```bash
node test/run-tests.mjs    # 模拟浏览器的单元测试（约 200 条断言，覆盖全部功能）
node test/probe-served.mjs # 校验运行中的 DSH 提供的是当前磁盘上的 client 构建
```

## 反馈与贡献

遇到问题或有建议，欢迎[提交 Issue](https://github.com/RevxZxCx/dsh-where-did-my-tokens-go/issues)。请附上 DSH 与插件版本、复现步骤；界面问题可附完整截图。若表单显示「该插件当前未加载，暂时无法配置」，说明宿主端未挂载——请先用 `dsh --profile desktop --dump-config`（或查看配置目录的 `cordis.patch.yml`）确认后再提 issue。

## 许可证

[MIT](LICENSE)
