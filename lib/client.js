window.__ModuleLoader__.load({
  id: "dsh-token-counter",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ── dependencies ─────────────────────────────────────────────────
    const reactJsx = require("react/jsx-runtime");
    const { jsx, jsxs } = reactJsx;
    const react = require("react");
    const { useState, useRef, useEffect } = react;
    // CONTRACT: the jsx/jsxs runtime signature is (type, config, maybeKey).
    // Children travel INSIDE config.children — trailing arguments are read as a
    // React key, and anything past them is silently dropped. Passing children
    // positionally renders an empty element, so every call site below puts its
    // children in `children`.
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const { SettingsForm, SettingsFormModel, Switch } = primitives;

    // ── constants ────────────────────────────────────────────────────
    const CONFIG_NS = "dsh-token-counter";      // settings namespace (= profile entry id)
    const LOCALE_NS = "settings.tokenCounter";  // locale dictionary namespace

    // ── token estimation ─────────────────────────────────────────────
    // The provider stream carries TEXT deltas, not per-token counts. The
    // authoritative `usage` only lands on `assistant/message` at settle time.
    // For a live rolling number we estimate client-side:
    //   CJK / full-width glyphs   ≈ 1 token each
    //   ASCII / latin glyphs      ≈ 4 chars per token
    const CJK_RE = /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

    function isCjk(ch) {
      return CJK_RE.test(ch);
    }

    function countDelta(c, text) {
      if (!text) return;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (/\s/.test(ch)) continue;
        if (isCjk(ch)) c.cjk += 1;
        else c.latin += 1;
      }
    }

    function estimate(c) {
      return c.cjk + Math.round(c.latin / 4);
    }

    function makeState(inheritedIn) {
      return {
        cjk: 0,
        latin: 0,
        phase: "input",      // "input" -> "output" once the first output delta lands
        inTokens: null,      // authoritative inputTokens (usage chunk / settle)
        outTokens: null,     // authoritative outputTokens (usage chunk / settle)
        lastIn: inheritedIn ?? null, // previous step's input, a fallback for prefill
      };
    }

    // ── settings-card field specs ────────────────────────────────────
    // Only number/text field specs ship with primitives; booleans and enums
    // need custom { field, format, parse } specs so SettingsFormModel can stage
    // typed values and emit {op:"set", path:[field], value:<typed>}.
    function enumSpec(field) {
      return {
        field,
        format: (v) => String(v),
        parse: (text) => ({ kind: "set", value: text }),
      };
    }

    function boolSpec(field) {
      return {
        field,
        format: (v) => (v === true ? "true" : "false"),
        parse: (text) => ({ kind: "set", value: text === "true" }),
      };
    }

    // ── locale ───────────────────────────────────────────────────────
    let t = (k) => k; // replaced in apply()

    const zh = {
      title: "Token 计数器",
      description:
        "在深度思考指示器后实时显示输入 / 输出 token，并在每个已完成的操作后显示该操作自身消耗的 token。",
      displayMode: "显示模式",
      displayModeMerged: "合并模式",
      displayModeSplit: "分开模式",
      showInput: "显示输入 token（in）",
      showOutput: "显示输出 token（out）",
      showPerOp: "在已完成操作后显示消耗 token（use）",
      previewTitle: "预览",
      previewHint: "点击卡片切换显示模式；将鼠标悬停在卡片上即可预览数字变化。",
      previewThinking: "深度思考",
      previewDone: "已完成命令",
      switchesTitle: "显示内容",
      save: "保存",
      saving: "保存中…",
      discard: "放弃修改",
      readOnly: "只读",
      unavailable: "设置不可用",
      saveFailed: "保存失败",
    };

    const en = {
      title: "Token Counter",
      description:
        "Shows live input/output tokens after the deep-thinking indicator, and each completed operation's own token usage after it.",
      displayMode: "Display mode",
      displayModeMerged: "Merged",
      displayModeSplit: "Split",
      showInput: "Show input tokens (in)",
      showOutput: "Show output tokens (out)",
      showPerOp: "Show consumed tokens after completed operations (use)",
      previewTitle: "Preview",
      previewHint: "Click a card to switch display mode; hover a card to watch the numbers move.",
      previewThinking: "Deep thinking",
      previewDone: "Command finished",
      switchesTitle: "What to show",
      save: "Save",
      saving: "Saving…",
      discard: "Discard",
      readOnly: "Read only",
      unavailable: "Settings unavailable",
      saveFailed: "Save failed",
    };

    // ── settings card ────────────────────────────────────────────────
    // Fake figures for the preview cards. They mirror the real badge shapes so
    // the user can see WHERE each number lives before saving anything.
    const FAKE_IN = 1866;
    const FAKE_OUT = 348;
    const FAKE_USE = 2378;
    const PREVIEW_TICK_MS = 40;

    // The preview counter animation state machine, advanced one tick at a time.
    // merged: the label swaps (in -> pause -> out); split: in fills, pauses,
    // then out fills while both stay visible. Values stop at their caps.
    function previewAdvance(frame, mode, showInput, showOutput) {
      if (frame === null || frame.done) return frame;
      const next = { ...frame };
      const step = (cap) => Math.max(4, Math.round(cap / 26));
      if (mode === "merged") {
        if (next.phase === "in") {
          if (next.hold > 0) { next.hold -= 1; return next; }
          if (next.value >= FAKE_IN) {
            // paused at the cap: swap the label now
            if (showOutput) { next.phase = "out"; next.value = 0; next.hold = 0; }
            else next.done = true;
            return next;
          }
          next.value = Math.min(FAKE_IN, next.value + step(FAKE_IN));
          if (next.value >= FAKE_IN) next.hold = 6;   // linger on the full in number
        } else {
          if (next.hold > 0) { next.hold -= 1; return next; }
          if (next.value >= FAKE_OUT) { next.done = true; return next; }
          next.value = Math.min(FAKE_OUT, next.value + step(FAKE_OUT));
          if (next.value >= FAKE_OUT) next.hold = 4;  // show the final number, then stop
        }
        return next;
      }
      // split
      if (next.stage === "in") {
        if (next.hold > 0) { next.hold -= 1; return next; }
        if (next.inValue >= FAKE_IN) {
          if (showOutput) { next.stage = "out"; next.hold = 3; }
          else next.done = true;
          return next;
        }
        next.inValue = Math.min(FAKE_IN, next.inValue + step(FAKE_IN));
        if (next.inValue >= FAKE_IN) next.hold = 5;   // pause before the out phase
      } else {
        if (next.hold > 0) { next.hold -= 1; return next; }
        if (next.outValue >= FAKE_OUT) { next.done = true; return next; }
        next.outValue = Math.min(FAKE_OUT, next.outValue + step(FAKE_OUT));
        if (next.outValue >= FAKE_OUT) next.hold = 4;
      }
      return next;
    }

    function previewIdleFrame(mode, showInput, showOutput) {
      if (mode === "split") {
        return { stage: showInput ? "in" : "out", inValue: showInput ? FAKE_IN : 0, outValue: showOutput ? FAKE_OUT : 0, hold: 0, done: true };
      }
      return { phase: showOutput ? "out" : "in", value: showOutput ? FAKE_OUT : FAKE_IN, hold: 0, done: true };
    }

    function previewStartFrame(showInput, showOutput) {
      if (!showInput && !showOutput) return null;
      return {
        phase: showInput ? "in" : "out",
        value: 0,
        stage: showInput ? "in" : "out",
        inValue: 0,
        outValue: 0,
        hold: 0,
        done: false,
      };
    }

    function previewBadgeText(mode, frame, showInput, showOutput) {
      if (frame === null) return "";
      if (mode === "split") {
        const parts = [];
        if (showInput) parts.push("in " + frame.inValue + " token");
        if (showOutput) parts.push("out " + frame.outValue + " token");
        return parts.join(" · ");
      }
      if (frame.phase === "in") return showInput ? "in " + frame.value + " token" : "";
      return showOutput ? "out " + frame.value + " token" : "";
    }

    // One preview card: a miniature of the real transcript — a completed
    // operation row ("已完成命令" + `use N token`, static) and the blue
    // deep-thinking row with the live badge. Numbers move only while hovered.
    function ModePreviewCard(props) {
      const { mode, t } = props;
      const [hover, setHover] = useState(false);
      const [frame, setFrame] = useState(null);
      const timerRef = useRef(0);

      useEffect(() => {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = 0; }
        if (!hover) { setFrame(null); return; }
        const start = previewStartFrame(props.showInput, props.showOutput);
        if (start === null) return;
        let current = start;
        setFrame({ ...current });
        timerRef.current = setInterval(() => {
          current = previewAdvance(current, mode, props.showInput, props.showOutput);
          setFrame({ ...current });
          if (current.done && timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = 0;
          }
        }, PREVIEW_TICK_MS);
        return () => {
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = 0; }
        };
      }, [hover, mode, props.showInput, props.showOutput, props.showPerOp]);

      // While hovering: before the effect's first tick lands, render the START
      // frame (zeros), never the idle full figures — so the number visibly
      // climbs from 0, not flash-to-max-then-reset. Not hovering: the idle card
      // shows the complete fake counts, static.
      const activeFrame = hover ? (frame || previewStartFrame(props.showInput, props.showOutput)) : null;
      const badgeText = previewBadgeText(
        mode,
        activeFrame || previewIdleFrame(mode, props.showInput, props.showOutput),
        props.showInput,
        props.showOutput,
      );

      const thinking = hover && frame !== null && !frame.done;
      // Reuse the real badge markup so the preview paints with the same CSS the
      // counter uses in the chat (two counter-moving shimmer layers).
      const badge = badgeText === "" ? null
        : jsxs("span", {
            "data-dsh-token-counter": "true",
            "data-dtc-live": thinking ? "true" : "false",
            children: [
              jsx("span", { className: "dsh-token-counter-content", children: badgeText }),
              thinking ? jsx("span", {
                className: "dsh-token-counter-dec",
                "aria-hidden": "true",
                children: jsx("span", {
                  className: "dsh-token-counter-sweep",
                  children: jsx("span", {
                    className: "dsh-token-counter-content dsh-token-counter-highlight",
                    children: badgeText,
                  }),
                }),
              }) : null,
            ],
          });

      return jsxs("div", {
        role: "button",
        tabIndex: 0,
        className: "dtc-card" + (props.selected ? " dtc-cardOn" : ""),
        "data-dtc-mode": mode,
        "aria-pressed": props.selected ? "true" : "false",
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setHover(true),
        onBlur: () => setHover(false),
        onClick: props.disabled ? undefined : () => props.onSelect(mode),
        onKeyDown: props.disabled ? undefined : (event) => {
          if (event.key === "Enter" || event.key === " ") props.onSelect(mode);
        },
        children: [
          jsxs("div", {
            className: "dtc-cardTitle",
            children: [
              jsx("span", { children: t(mode === "merged" ? "displayModeMerged" : "displayModeSplit") }),
              jsx("span", { className: "dtc-cardDot", "aria-hidden": "true" }),
            ],
          }),
          jsxs("div", {
            className: "dtc-chat",
            children: [
              props.showPerOp ? jsxs("div", {
                className: "dtc-opRow",
                children: [
                  jsx("span", { className: "dtc-opIcon", "aria-hidden": "true", children: ">_" }),
                  jsx("span", { className: "dtc-opLabel", children: t("previewDone") }),
                  jsx("span", { className: "dtc-opUse", children: "use " + FAKE_USE + " token" }),
                ],
              }) : null,
              jsx("div", { className: "dtc-divider", "aria-hidden": "true" }),
              jsxs("div", {
                className: "dtc-thinkRow",
                children: [
                  jsx("span", { className: "dtc-thinkDot", "aria-hidden": "true" }),
                  jsx("span", { className: "dtc-thinkLabel", children: t("previewThinking") }),
                  badge,
                ],
              }),
            ],
          }),
        ],
      });
    }

    class TokenCounterCardController {
      constructor(scope) {
        this.form = new SettingsFormModel(scope, [
          enumSpec("displayMode"),
          boolSpec("showInput"),
          boolSpec("showOutput"),
          boolSpec("showPerOp"),
        ]);
        this.store = this.form.bind(() => this.projection());
      }

      projection() {
        return {
          ...this.form.shell(),
          displayMode: this.form.field("displayMode"),
          showInput: this.form.field("showInput"),
          showOutput: this.form.field("showOutput"),
          showPerOp: this.form.field("showPerOp"),
        };
      }

      inject() {
        return { hooks: { tokenCounterCard: this.store }, ...this.form.actions() };
      }

      dispose() {
        this.form.dispose();
      }
    }

    function TokenCounterCard(props) {
      const tCard = props.t || t;
      const state = props.useTokenCounterCard((s) => s);
      if (props.view === "summary") {
        return jsx("p", { children: tCard("description") });
      }

      const labels = {
        unavailable: tCard("unavailable"),
        readOnly: tCard("readOnly"),
        saveFailed: tCard("saveFailed"),
        save: tCard("save"),
        saving: tCard("saving"),
        discard: tCard("discard"),
      };

      const showInput = state.showInput.text === "true";
      const showOutput = state.showOutput.text === "true";
      const showPerOp = state.showPerOp.text === "true";
      const mode = state.displayMode.text;
      const editable = state.writable;

      // The platform `Switch` renders only the toggle itself (its `label` prop
      // is an aria-label), so each row carries its own visible caption.
      const switchRow = (caption, checked, onToggle) =>
        jsxs("div", {
          className: "dtc-switchRow",
          children: [
            jsx("span", { className: "dtc-switchLabel", children: caption }),
            jsx(Switch, {
              checked,
              onChange: onToggle,
              label: caption,
              disabled: !editable,
            }),
          ],
        });

      const previewCard = (cardMode) => jsx(ModePreviewCard, {
        mode: cardMode,
        t: tCard,
        selected: mode === cardMode,
        showInput,
        showOutput,
        showPerOp,
        disabled: !editable,
        onSelect: (value) => props.edit("displayMode", value),
      }, cardMode);

      const children = state.available
        ? jsxs("div", {
            className: "dtc-layout",
            children: [
              jsxs("section", {
                className: "dtc-previews",
                children: [
                  jsxs("div", {
                    className: "dtc-head",
                    children: [
                      jsx("h3", { className: "dtc-headTitle", children: tCard("previewTitle") }),
                      jsx("p", { className: "dtc-headHint", children: tCard("previewHint") }),
                    ],
                  }),
                  jsx("div", {
                    className: "dtc-cards",
                    role: "group",
                    "aria-label": tCard("displayMode"),
                    children: [previewCard("merged"), previewCard("split")],
                  }),
                ],
              }),
              jsxs("section", {
                className: "dtc-switches",
                children: [
                  jsx("h3", { className: "dtc-headTitle", children: tCard("switchesTitle") }),
                  switchRow(tCard("showInput"), showInput, (checked) =>
                    props.edit("showInput", checked ? "true" : "false")
                  ),
                  switchRow(tCard("showOutput"), showOutput, (checked) =>
                    props.edit("showOutput", checked ? "true" : "false")
                  ),
                  switchRow(tCard("showPerOp"), showPerOp, (checked) =>
                    props.edit("showPerOp", checked ? "true" : "false")
                  ),
                ],
              }),
            ],
          })
        : null;

      const form = jsx(SettingsForm, {
        labels,
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children,
      });

      // The Plugins-page card gets its heading from the page chrome. The Settings
      // section is a bare panel, so it renders its own heading + description.
      if (props.section !== true) return form;
      return jsxs("div", {
        className: "dsh-token-counter-section",
        children: [
          jsx("h2", {
            className: "dsh-token-counter-sectionTitle",
            children: tCard("title"),
          }),
          jsx("p", {
            className: "dsh-token-counter-sectionIntro",
            children: tCard("description"),
          }),
          form,
        ],
      });
    }

    // ── DOM helpers ──────────────────────────────────────────────────
    const STYLE_ID = "dsh-token-counter-style";

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = [
        // ── settings layout: light, tidy, adaptive ──────────────────
        // White cards on a pale-grey field, with a two-column grid that
        // collapses to one column on narrow panels (plugins page, small windows).
        ".dtc-layout{display:flex;flex-direction:column;gap:16px;}",
        ".dtc-head{display:flex;flex-direction:column;gap:2px;}",
        ".dtc-headTitle{margin:0;font-size:13px;font-weight:600;color:#1f2328;}",
        ".dtc-headHint{margin:0;font-size:12px;line-height:1.5;color:#8b949e;}",
        ".dtc-previews{display:flex;flex-direction:column;gap:10px;}",
        ".dtc-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;}",
        // one preview card
        ".dtc-card{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;cursor:pointer;text-align:left;font:inherit;",
        " background:#ffffff;border:1px solid #e5e9ef;color:#1f2328;",
        " transition:border-color .15s ease,box-shadow .15s ease;}",
        ".dtc-card:hover{border-color:#c9d3e0;box-shadow:0 2px 10px rgba(31,35,40,.06);}",
        ".dtc-card:focus-visible{outline:2px solid #2563eb;outline-offset:2px;}",
        ".dtc-cardOn{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.10);}",
        ".dtc-cardTitle{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#57606a;}",
        ".dtc-cardDot{margin-left:auto;width:8px;height:8px;border-radius:50%;background:transparent;border:1px solid #c9d3e0;}",
        ".dtc-cardOn .dtc-cardDot{background:#2563eb;border-color:#2563eb;}",
        // the miniature transcript inside a card
        ".dtc-chat{display:flex;flex-direction:column;gap:0;border-radius:8px;background:#f6f8fa;border:1px solid #e5e9ef;padding:10px 12px;min-width:0;}",
        ".dtc-opRow{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:#57606a;min-width:0;}",
        ".dtc-opIcon{flex:none;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10px;color:#8b949e;}",
        ".dtc-opLabel{white-space:nowrap;}",
        ".dtc-opUse{white-space:nowrap;opacity:.62;font-variant-numeric:tabular-nums;}",
        ".dtc-divider{height:1px;background:#e5e9ef;margin:8px 0;}",
        ".dtc-thinkRow{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:#2563eb;min-width:0;}",
        ".dtc-thinkDot{flex:none;width:6px;height:6px;border-radius:50%;background:#2563eb;opacity:.65;}",
        ".dtc-thinkLabel{white-space:nowrap;}",
        // the badge inside the preview: same layered CSS as the real chat badge,
        // recolored for the light card (blue text, pale-blue sweep band).
        ".dtc-card [data-dsh-token-counter]{margin-left:2px;color:#2563eb;}",
        ".dtc-card [data-dsh-token-counter] .dsh-token-counter-sweep{color:#9ecbff;}",
        // switches column
        ".dtc-switches{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;background:#f6f8fa;border:1px solid #e5e9ef;}",
        ".dtc-switchRow{display:flex;align-items:center;justify-content:space-between;gap:12px;}",
        ".dtc-switchLabel{font-size:13px;line-height:1.5;color:#1f2328;}",
        // standalone settings section (own heading + description)
        ".dsh-token-counter-section{display:flex;flex-direction:column;gap:12px;max-width:760px;}",
        ".dsh-token-counter-sectionTitle{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary);}",
        ".dsh-token-counter-sectionIntro{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary);}",
        // ── the real chat badge (after the deep-thinking indicator) ───
        // Inherit the row's own font and color, and let the row's shimmer
        // variable drive the highlight: `.xz4KEq_running` sets
        // `--dsw-alias-label-shimmer: var(--dsw-alias-label-deep-diving-shimmer)`
        // and `color: var(--dsw-alias-label-deep-diving)`, so the counter reads
        // as part of the same sentence instead of a second, differently styled one.
        "[data-dsh-token-counter]{position:relative;display:inline-grid;width:max-content;max-width:100%;min-width:0;vertical-align:top;color:inherit;font:inherit;white-space:nowrap;user-select:none;font-variant-numeric:tabular-nums;}",
        "[data-dsh-token-counter] .dsh-token-counter-content{display:flex;align-items:center;min-width:0;color:inherit;}",
        // Mirror of TextShimmer.module.css: the mask travels one way, the text
        // the other, so the glyphs never move and only a light band crosses them.
        "[data-dsh-token-counter] .dsh-token-counter-dec{position:absolute;inset:0;overflow:clip;pointer-events:none;user-select:none;}",
        "[data-dsh-token-counter] .dsh-token-counter-sweep{position:absolute;inset:0;overflow:hidden;color:var(--dsw-alias-label-shimmer,#fff);-webkit-mask-image:linear-gradient(105deg,transparent 0%,#000 40% 60%,transparent 100%);mask-image:linear-gradient(105deg,transparent 0%,#000 40% 60%,transparent 100%);transform:translateX(-100%);}",
        "[data-dsh-token-counter] .dsh-token-counter-sweep,[data-dsh-token-counter] .dsh-token-counter-highlight{animation-name:dsh-token-counter-sweep;animation-duration:1.5s;animation-delay:.3s;animation-timing-function:steps(48,end);animation-iteration-count:infinite;}",
        "[data-dsh-token-counter] .dsh-token-counter-highlight{width:100%;height:100%;transform:translateX(100%);animation-name:dsh-token-counter-highlight;}",
        "[data-dsh-token-counter] .dsh-token-counter-sweep *{color:inherit !important;}",
        "@keyframes dsh-token-counter-sweep{0%{transform:translateX(-100%);}66.6667%,100%{transform:translateX(100%);}}",
        "@keyframes dsh-token-counter-highlight{0%{transform:translateX(100%);}66.6667%,100%{transform:translateX(-100%);}}",
        "@media (prefers-reduced-motion: reduce){[data-dsh-token-counter] .dsh-token-counter-dec{display:none;}[data-dsh-token-counter] .dsh-token-counter-sweep,[data-dsh-token-counter] .dsh-token-counter-highlight{animation:none;}}",
        // per-operation "use N token" (matches the row's own text style)
        "[data-dsh-use-token]{margin-left:6px;font-size:12px;font-weight:normal;line-height:inherit;color:inherit;opacity:.62;white-space:nowrap;}",
      ].join("\n");
      document.head.appendChild(style);
    }

    // The blue "深度思考/深度求索" indicator is a hardcoded RunningStatus
    // (`.xz4KEq_running[data-chat-running]`) whose last child holds the whale
    // tail + shimmer text. We append our counter inside its content container.
    function findAnchor() {
      if (typeof document === "undefined") return null;
      const running = document.querySelector('[data-chat-running]');
      if (!running) return null;
      return (
        running.querySelector(".xz4KEq_runningContent") ||
        running.lastElementChild ||
        running
      );
    }

    // Build the badge with the platform's own shimmer geometry: one static text
    // layer plus a decorative layer whose mask sweeps right while its inner text
    // sweeps left, keeping every glyph in place. Colors come from the running row
    // through `color: inherit` and `--dsw-alias-label-shimmer`, so the counter
    // looks like the deep-thinking label it follows.
    //   span[data-dsh-token-counter]
    //     span.content            (real text)
    //     span.dec[aria-hidden]   (overlay, inert)
    //       span.sweep            (travelling mask)
    //         span.content.highlight (mirrored text, counter-travelling)
    function buildBadge(text) {
      const root = document.createElement("span");
      root.setAttribute("data-dsh-token-counter", "true");

      const content = document.createElement("span");
      content.className = "dsh-token-counter-content";
      content.textContent = text;

      const decoration = document.createElement("span");
      decoration.className = "dsh-token-counter-dec";
      decoration.setAttribute("aria-hidden", "true");
      decoration.setAttribute("inert", "");

      const sweep = document.createElement("span");
      sweep.className = "dsh-token-counter-sweep";

      const inner = document.createElement("span");
      inner.className = "dsh-token-counter-content dsh-token-counter-highlight";
      inner.textContent = text;

      sweep.appendChild(inner);
      decoration.appendChild(sweep);
      root.appendChild(content);
      root.appendChild(decoration);
      return root;
    }

    // Write new text into both layers of an existing badge.
    function setBadgeText(root, text) {
      const layers = [
        root.firstElementChild,
        root.querySelector(".dsh-token-counter-highlight"),
      ];
      for (const layer of layers) {
        if (layer && layer.textContent !== text) layer.textContent = text;
      }
    }

    // ── plugin entry ─────────────────────────────────────────────────
    function apply(ctx) {
      const sessions = ctx.get("sessions");
      const locale = ctx.get("locale");
      const slots = ctx.get("slots");
      const configForms = ctx.get("configForms");
      if (!sessions || typeof document === "undefined") return;

      // locale
      if (locale && locale.bind) t = locale.bind(LOCALE_NS);
      if (locale && locale.register) {
        ctx.effect(
          () => locale.register(LOCALE_NS, { zh, en }),
          "dsh-token-counter: locale"
        );
      }

      ensureStyle();

      // ── settings surfaces ──
      // The harness exposes several seats for a plugin's own configuration, and
      // its slot contract reserves `plugins.item` for the official settings
      // pages: "a bundle's configuration belongs in `plugins.bundle.config` or
      // `plugins.row.config` instead". We therefore mount the same controller
      // into every seat a host may declare (a slot that is never declared simply
      // never runs):
      //   1. `plugins.bundle.config`, keyed by the bundle's package name — the
      //      config section on this plugin's page in the Plugins panel;
      //   2. `settings.plugins.tab` — a page beside the built-in inventory in
      //      the Settings → 内置插件 (Plugins) section;
      //   3. `settings.section` — an own entry in the Settings panel's
      //      navigation, for users who never open the Plugins panel;
      //   4. `plugins.item` — the card in the Plugins panel's Official group.
      // All of them are gated on the Host serving our settings namespace.
      let card = null;
      if (configForms && slots && slots.inject) {
        const scope = configForms.get(CONFIG_NS);
        card = new TokenCounterCardController(scope);
        ctx.effect(() => () => card.dispose(), "dsh-token-counter: card dispose");
        const bundleConfigOptions = {
          name: "plugins.bundle.config",
          key: CONFIG_NS,
          order: 30,
          label: () => t("title"),
          locale: LOCALE_NS,
          inject: () => card.inject(),
        };
        const settingsTabOptions = {
          name: "settings.plugins.tab",
          id: CONFIG_NS,
          order: 30,
          label: () => t("title"),
          locale: LOCALE_NS,
          inject: () => Object.assign({}, card.inject(), { section: true }),
        };
        // An own entry in the Settings panel's navigation, so the options are
        // reachable without knowing where the platform files plugin config.
        const settingsSectionOptions = {
          name: "settings.section",
          id: CONFIG_NS,
          order: 45,
          label: () => t("title"),
          locale: LOCALE_NS,
          inject: () => Object.assign({}, card.inject(), { section: true }),
        };
        const itemOptions = {
          name: "plugins.item",
          id: CONFIG_NS,
          order: 30,
          label: () => t("title"),
          locale: LOCALE_NS,
          inject: () => card.inject(),
        };
        ctx.effect(
          () =>
            configForms.whileServed([CONFIG_NS], () => {
              const offs = [
                slots.inject("plugins.bundle.config", () =>
                  slots.register(bundleConfigOptions, TokenCounterCard)
                ),
                slots.inject("settings.plugins.tab", () =>
                  slots.register(settingsTabOptions, TokenCounterCard)
                ),
                slots.inject("settings.section", () =>
                  slots.register(settingsSectionOptions, TokenCounterCard)
                ),
                slots.inject("plugins.item", () =>
                  slots.register(itemOptions, TokenCounterCard)
                ),
              ];
              return () => {
                for (const off of offs) off?.();
              };
            }),
          "dsh-token-counter: settings surfaces"
        );
      }

      // ── live counter + per-op tokens ──
      const states = new Map();   // sessionId -> state
      // A completed operation row covers the steps that ran while it was the
      // live row, so usage is recorded PER STEP and attributed to the row that
      // was open when the step settled — never summed across the whole reply.
      // "sessionId:turn" -> step usage, kept in step order
      const stepRecords = new Map();
      let cfg = readCfg();
      let activeId;
      let stopEvent = null;
      let stopList = null;
      let stopCfg = null;
      let counterSpan = null;
      let raf = 0;
      let pollTimer = null;

      function readCfg() {
        try {
          const scope = configForms && configForms.get(CONFIG_NS);
          const snap = scope && scope.getSnapshot ? scope.getSnapshot() : null;
          const v = snap && snap.value;
          return {
            displayMode: v && v.displayMode ? v.displayMode : "merged",
            showInput: v ? v.showInput !== false : true,
            showOutput: v ? v.showOutput !== false : true,
            showPerOp: v ? v.showPerOp !== false : true,
          };
        } catch (e) {
          return { displayMode: "merged", showInput: true, showOutput: true, showPerOp: true };
        }
      }

      const currentId = () => {
        try {
          const snap = sessions.list.getSnapshot();
          return Object.values(snap.byId).find(
            (s) => (s.retainedBy?.mainView ?? 0) > 0
          )?.id;
        } catch (e) {
          return undefined;
        }
      };

      // The harness prices the prompt it is about to send through the
      // token-meter `contextPressure` projection (`projectedTokens`), which the
      // session list carries to the browser as `projectionValues`. That is the
      // real input count during the prefill phase, long before the provider
      // reports `inputTokens` at settle time.
      const readPressure = () => {
        try {
          const snap = sessions.list.getSnapshot();
          const entry = activeId !== undefined ? snap.byId[activeId] : undefined;
          const pressure = entry && entry.projectionValues && entry.projectionValues.contextPressure;
          if (!pressure) return null;
          const v = pressure.projectedTokens ?? pressure.pressureTokens;
          return typeof v === "number" && Number.isFinite(v) ? v : null;
        } catch (e) {
          return null;
        }
      };

      function buildBadgeText(s) {
        if (!s) return "";
        const outVal = s.outTokens != null ? s.outTokens : estimate(s);
        // Input count precedence: the provider's settled figure for this request,
        // then the harness's live priced prompt, then the last input we learned
        // (a later step's prefill before its own projection lands).
        const inVal = s.inTokens != null ? s.inTokens : (readPressure() ?? s.lastIn);
        const outText = "out " + outVal + " token";
        const inText = inVal != null ? "in " + inVal + " token" : null;

        if (cfg.displayMode === "split") {
          // Fixed: both counts, for the whole turn.
          const parts = [];
          if (cfg.showInput && inText) parts.push(inText);
          if (cfg.showOutput) parts.push(outText);
          return parts.join(" · ");
        }

        // Merged: the label swaps, it never stacks. The input count stands while
        // the request is being prepared; once the answer starts streaming it
        // becomes the output count. If no input number exists yet (a deployment
        // whose token-meter projection has not landed), fall back to showing the
        // output count rather than blanking the row: the indicator is running and
        // an honest 0 beats a missing counter.
        const outputting = s.phase === "output" || outVal > 0;
        if (outputting) return cfg.showOutput ? outText : "";
        if (cfg.showInput && inText) return inText;
        return cfg.showOutput ? outText : "";
      }

      const syncBadge = () => {
        raf = 0;
        const anchor = findAnchor();
        // While the row is running we always have something to price: a session
        // that has not produced an event we recognise yet still shows the input
        // count, so the prefill phase is never blank.
        const s = anchor
          ? (activeId !== undefined ? states.get(activeId) : undefined) || makeState()
          : undefined;
        const text = buildBadgeText(s);

        if (anchor && text) {
          if (!counterSpan || counterSpan.parentNode !== anchor) {
            if (counterSpan && counterSpan.parentNode) counterSpan.remove();
            counterSpan = buildBadge(text);
            anchor.appendChild(counterSpan);
          } else {
            setBadgeText(counterSpan, text);
          }
        } else if (counterSpan && counterSpan.parentNode) {
          counterSpan.remove();
          counterSpan = null;
        }
      };

      // Per-turn step records and per-row attribution live under the session id,
      // so switching sessions never mixes two transcripts' ledgers.
      const scoped = (map, turn, make) => {
        const key = activeId + ":" + turn;
        let value = map.get(key);
        if (value === undefined) {
          value = make();
          map.set(key, value);
        }
        return value;
      };

      const readTurnOf = (btn) => {
        const group = btn.closest("[data-chat-turn]");
        if (!group) return undefined;
        const n = Number(group.getAttribute("data-chat-turn"));
        return Number.isFinite(n) ? n : undefined;
      };

      // Every operation row of the transcript, in document order, with the turn
      // it belongs to and whether its step has finished (a still-streaming label
      // carries the shimmer decoration).
      const scanRows = () => {
        const buttons = document.querySelectorAll("button[data-process-activity]");
        const rows = [];
        for (let i = 0; i < buttons.length; i++) {
          const btn = buttons[i];
          const turn = readTurnOf(btn);
          if (turn === undefined) continue;
          rows.push({ btn, turn, closed: !btn.querySelector("[data-shimmer]") });
        }
        return rows;
      };

      // Each operation row is one step of its turn: the model thinks (or runs a
      // command), that step settles with its own usage, the row closes. So rows
      // are walked in document order and each takes the NEXT settled step of its
      // turn — a row shows its own step's tokens, never the reply's total, and a
      // row whose step has not settled yet (or a reload, where nothing settles)
      // shows nothing rather than a borrowed number.
      const syncPerOp = () => {
        if (typeof document === "undefined" || activeId === undefined) return;
        const rows = scanRows();

        const cursor = new Map(); // turn -> next step index
        const totals = new Map(); // row -> token total
        for (const row of rows) {
          if (!cursor.has(row.turn)) cursor.set(row.turn, 0);
          const records = scoped(stepRecords, row.turn, () => []);
          const index = cursor.get(row.turn);
          cursor.set(row.turn, index + 1);
          if (!row.closed) continue;
          const record = records[index];
          if (record === undefined) continue;
          // Prefer the provider's authoritative totalTokens; fall back to
          // input+output when a provider omits totalTokens.
          totals.set(row, record.total > 0 ? record.total : record.in + record.out);
        }

        for (const row of rows) {
          let span = row.btn.querySelector("[data-dsh-use-token]");
          if (!row.closed) {
            if (span) span.remove();
            continue;
          }
          const total = totals.get(row);
          if (total === undefined) {
            if (span) span.remove();
            continue;
          }
          const text = "use " + total + " token";
          if (!span) {
            span = document.createElement("span");
            span.setAttribute("data-dsh-use-token", "true");
            row.btn.appendChild(span);
          }
          if (span.textContent !== text) span.textContent = text;
        }
      };

      const scheduleSync = () => {
        if (raf) return;
        raf = typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(syncBadge)
          : setTimeout(syncBadge, 16);
      };

      // Settle-time re-attribution: a row can only be numbered once its step's
      // usage lands, so refresh the labels on the same frame.
      let perOpQueued = false;
      const schedulePerOp = () => {
        if (perOpQueued) return;
        perOpQueued = true;
        const run = () => {
          perOpQueued = false;
          syncPerOp();
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
        else setTimeout(run, 16);
      };

      const handleEntries = (entries, mode) => {
        let s = states.get(activeId);
        if (mode === "replace" || s === undefined) s = makeState();
        let dirty = false;

        for (const entry of entries) {
          const ev = entry && entry.event;
          if (!ev) continue;
          const ty = ev.type;

          if (ty === "assistant/live-chunk") {
            const chunk = ev.data && ev.data.chunk;
            if (!chunk) continue;
            if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
              countDelta(s, chunk.text);
              if (s.phase !== "output") s.phase = "output";
              dirty = true;
            } else if (chunk.type === "usage" && chunk.usage) {
              // "usage" chunk arrives at the end of the stream — earliest
              // authoritative in/out snapshot.
              if (typeof chunk.usage.inputTokens === "number") {
                s.inTokens = chunk.usage.inputTokens;
                s.lastIn = chunk.usage.inputTokens;
              }
              if (typeof chunk.usage.outputTokens === "number") s.outTokens = chunk.usage.outputTokens;
              dirty = true;
            }
          } else if (ty === "step/start" || ty === "turn/start") {
            // Carry the last known input as the new step's prefill estimate: the
            // projection for a later step can land a beat after its own start.
            s = makeState(s.inTokens ?? s.lastIn);
            dirty = true;
          } else if (ty === "assistant/message") {
            const data = ev.data || {};
            const usage = data.usage;
            if (usage) {
              if (typeof usage.inputTokens === "number") s.inTokens = usage.inputTokens;
              if (typeof usage.outputTokens === "number") s.outTokens = usage.outputTokens;
              if (s.inTokens != null) s.lastIn = s.inTokens;
              const turn = data.turn;
              if (turn !== undefined) recordStep(turn, data.step, usage);
              dirty = true;
            }
          }
        }

        if (dirty || mode === "replace") {
          states.set(activeId, s);
          scheduleSync();
        }
      };

      // One settled `assistant/message` prices ONE step. Records are kept per
      // turn IN STEP ORDER, replacing a step's figure when it re-settles (a
      // retried attempt or a re-landed message must never count twice).
      function recordStep(turn, step, usage) {
        const records = scoped(stepRecords, turn, () => []);
        const record = {
          in: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
          out: typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
          total: typeof usage.totalTokens === "number" ? usage.totalTokens : 0,
        };
        const index = typeof step === "number" ? records.findIndex((item) => item.step === step) : -1;
        if (index >= 0) {
          record.step = step;
          records[index] = record;
        } else {
          record.step = typeof step === "number" ? step : records.length;
          records.push(record);
        }
        schedulePerOp();
      }

      const attach = (sid) => {
        if (activeId === sid) return;
        activeId = sid;
        if (stopEvent) {
          try { stopEvent(); } catch (e) {}
          stopEvent = null;
        }
        if (sid === undefined) return;
        const binding = sessions.binding(sid);
        if (!binding || !binding.eventSource) return;
        stopEvent = binding.eventSource.subscribe(() => {
          try {
            const snap = binding.eventSource.getSnapshot();
            const change = snap && snap.change;
            if (!change) return;
            if (change.kind === "append") {
              handleEntries(change.entries, "append");
            } else if (change.kind === "replace") {
              handleEntries(snap.entries, "replace");
            }
          } catch (e) { /* ignore */ }
        });
      };

      if (sessions.list && sessions.list.subscribe) {
        stopList = sessions.list.subscribe(() => {
          try { attach(currentId()); } catch (e) {}
        });
      }
      attach(currentId());

      if (configForms) {
        const scope = configForms.get(CONFIG_NS);
        if (scope && scope.subscribe) {
          stopCfg = scope.subscribe(() => {
            cfg = readCfg();
            scheduleSync();
          });
        }
      }

      // Lightweight poll so React mount/unmount timing never desyncs the
      // badge, and per-op "use N token" spans stay up to date with settle usage.
      pollTimer = window.setInterval(() => {
        syncBadge();
        if (cfg.showPerOp) syncPerOp();
      }, 400);

      ctx.effect(
        () => () => {
          if (pollTimer !== null) window.clearInterval(pollTimer);
          if (stopCfg) { try { stopCfg(); } catch (e) {} }
          if (stopList) { try { stopList(); } catch (e) {} }
          if (stopEvent) { try { stopEvent(); } catch (e) {} }
          if (raf) {
            if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
            else clearTimeout(raf);
          }
          if (counterSpan && counterSpan.parentNode) counterSpan.remove();
          if (typeof document !== "undefined") {
            const spans = document.querySelectorAll("[data-dsh-use-token]");
            for (const sp of spans) sp.remove();
          }
        },
        "dsh-token-counter: cleanup"
      );
    }

    const inject = ["sessions", "slots", "locale", "configForms"];
    exports.apply = apply;
    exports.inject = inject;
    // Preview state machine, exposed for tests (the DOM harness renders element
    // descriptors without mounting components, so the hover animation logic is
    // verified through these pure functions).
    exports.preview = {
      advance: previewAdvance,
      idleFrame: previewIdleFrame,
      startFrame: previewStartFrame,
      badgeText: previewBadgeText,
      FAKE_IN,
      FAKE_OUT,
      FAKE_USE,
    };
    return module.exports;
  }
});
