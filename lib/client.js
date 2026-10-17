window.__ModuleLoader__.load({
  id: "dsh-where-did-my-tokens-go",
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
    const CONFIG_NS = "dsh-where-did-my-tokens-go";      // settings namespace (= profile entry id)
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
        phase: "input",      // "input" -> "reasoning" -> "output"
        inTokens: null,      // authoritative inputTokens (usage chunk / settle)
        outTokens: null,     // authoritative outputTokens (usage chunk / settle)
        lastIn: inheritedIn ?? null, // previous step's input, a fallback for prefill
      };
    }

    // ── token unit formatting ────────────────────────────────────────
    // K/M/G/T = 1e3/1e6/1e9/1e12. "auto" picks the largest unit whose scale
    // the value reaches, so the number never grows past four digits plus a
    // decimal; a fixed unit is applied as chosen, however small the quotient.
    const UNIT_SCALES = { K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
    const UNIT_ORDER = ["T", "G", "M", "K"];
    // trimUnitValue rounds values >=100 to integers, so a quotient from 999.5
    // rounds to 1000: that is where promotion must kick in (Math.round is
    // half-up, so the boundary IS 999.5, not 999.95).
    const PROMOTE_AT = 999.5;

    function trimUnitValue(value) {
      const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
      return String(rounded);
    }

    // A preview/segment number is `value` tokens rendered under `unit`. "auto"
    // picks the largest reached unit; rounding that reaches 1000 promotes to
    // the next unit (999_500 must read "1M", never "1000K"). A fixed unit
    // promotes stepwise while its digits would still overflow.
    function formatTokens(n, unit) {
      const value = Number.isFinite(n) && n > 0 ? n : 0;
      if (unit && unit !== "auto" && Object.hasOwn(UNIT_SCALES, unit)) {
        let current = unit;
        let scaled = value / UNIT_SCALES[current];
        while (scaled >= PROMOTE_AT && current !== "T") {
          const upper = UNIT_ORDER[UNIT_ORDER.indexOf(current) - 1];
          if (upper === undefined) break;
          current = upper;
          scaled = value / UNIT_SCALES[current];
        }
        return trimUnitValue(scaled) + current;
      }
      for (let i = 0; i < UNIT_ORDER.length; i++) {
        const suffix = UNIT_ORDER[i];
        if (value < UNIT_SCALES[suffix]) continue;
        const scaled = value / UNIT_SCALES[suffix];
        const upper = i > 0 ? UNIT_ORDER[i - 1] : null;   // next larger unit
        if (upper && scaled >= PROMOTE_AT) {
          // auto scans top-down, so one promotion always lands under the cap
          const bumped = value / UNIT_SCALES[upper];
          return trimUnitValue(bumped) + upper;
        }
        return trimUnitValue(scaled) + suffix;
      }
      return String(Math.round(value));
    }

    // A site style from config: fontSize 0 means "follow the host row", color
    // "" means inherit. Anything else is applied inline on the segment.
    const COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

    function sanitizeFont(raw) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return 0;
      return Math.min(96, Math.round(n));
    }

    function sanitizeColor(raw) {
      return typeof raw === "string" && COLOR_RE.test(raw) ? raw : "";
    }

    function siteStyle(font, color) {
      const style = {};
      if (font > 0) style.fontSize = font + "px";
      if (color) style.color = color;
      return style;
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

    // Font size drafts: a number; empty clears back to the schema default (0 =
    // follow the host row). Anything that is not a number is invalid, so the
    // form refuses to save it rather than dropping the edit.
    function numberSpec(field) {
      return {
        field,
        format: (v) => (typeof v === "number" ? String(v) : ""),
        parse: (text) => {
          const trimmed = text.trim();
          if (trimmed === "") return { kind: "clear" };
          const parsed = Number(trimmed);
          return Number.isFinite(parsed) ? { kind: "set", value: parsed } : void 0;
        },
      };
    }

    // Color drafts: a hex string; empty clears back to the schema default
    // ("", which means "inherit the row color").
    function colorSpec(field) {
      return {
        field,
        format: (v) => (typeof v === "string" ? v : ""),
        parse: (text) => ({ kind: "set", value: text }),
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
      gearLabel: "样式设置",
      unitField: "显示单位",
      fontField: "字体大小",
      fontHint: "留空或 0 表示跟随界面文字",
      colorField: "颜色",
      colorNone: "跟随界面",
      unitAuto: "自适应",
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
      gearLabel: "Style settings",
      unitField: "Unit",
      fontField: "Font size",
      fontHint: "Empty or 0 follows the interface text",
      colorField: "Color",
      colorNone: "Follow theme",
      unitAuto: "Auto",
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

    // The preview replays the real badge's chronology — prefill (`in`), then
    // answering (`out`) — skipping any stage its switch has turned off. merged
    // shows one stage at a time; split keeps every enabled number on screen
    // while they climb in turn.
    const PREVIEW_STAGES = ["in", "out"];
    const PREVIEW_CAPS = { in: FAKE_IN, out: FAKE_OUT };

    function previewStages(showInput, showOutput) {
      return PREVIEW_STAGES.filter((stage) =>
        stage === "in" ? showInput : showOutput
      );
    }

    function previewAdvance(frame, stages) {
      if (frame === null || frame.done) return frame;
      const next = { ...frame, values: { ...frame.values } };
      if (stages.length === 0) { next.done = true; return next; }
      const stage = stages[Math.min(next.index, stages.length - 1)];
      const cap = PREVIEW_CAPS[stage];
      const step = Math.max(4, Math.round(cap / 26));
      if (next.hold > 0) { next.hold -= 1; return next; }
      if (next.values[stage] >= cap) {
        if (next.index + 1 >= stages.length) { next.done = true; return next; }
        // paused at this stage's cap: move on to the next one
        next.index += 1;
        next.stage = stages[next.index];
        next.hold = 2;
        return next;
      }
      next.values[stage] = Math.min(cap, next.values[stage] + step);
      if (next.values[stage] >= cap) next.hold = 4;   // linger on the full number
      return next;
    }

    // The idle card shows the finished state: every enabled number, with the
    // LAST stage selected (merged renders only the selected stage).
    function previewIdleFrame(showInput, showOutput) {
      const stages = previewStages(showInput, showOutput);
      return {
        index: Math.max(0, stages.length - 1),
        stage: stages.length ? stages[stages.length - 1] : "out",
        values: {
          in: showInput ? FAKE_IN : 0,
          out: showOutput ? FAKE_OUT : 0,
        },
        hold: 0,
        done: true,
      };
    }

    function previewStartFrame(showInput, showOutput) {
      const stages = previewStages(showInput, showOutput);
      if (stages.length === 0) return null;
      return {
        index: 0,
        stage: stages[0],
        values: { in: 0, out: 0 },
        hold: 0,
        done: false,
      };
    }

    // Preview badge as SEGMENTS (label + number), so per-site unit formatting
    // and per-site font/color can be applied to the number span only, exactly
    // as the live badge will do. `sites` = { input: {unit,font,color}, output:
    // {…}, perOp: {…} } resolved from the staged form.
    // Which styling site backs each rendered segment: `in` is the prefill, `out`
    // the answer — each has its own gear menu.
    const SITE_BY_KIND = { in: "input", out: "output" };

    function previewBadgeSegments(mode, frame, showInput, showOutput, sites) {
      if (frame === null) return [];
      const segs = [];
      const vals = frame.values;
      const push = (kind, value) => {
        const site = sites[SITE_BY_KIND[kind]];
        segs.push({ kind, label: kind + " ", number: formatTokens(value, site.unit), unit: site.unit, font: site.font, color: site.color });
      };
      if (mode === "split") {
        if (showInput) push("in", vals.in);
        if (showOutput) push("out", vals.out);
        return segs;
      }
      // merged: only the stage being animated is on screen.
      if (frame.stage === "in") { if (showInput) push("in", vals.in); return segs; }
      if (showOutput) push("out", vals.out);
      return segs;
    }

    // Flat text for tests: the badge (preview and live) renders segment NODES,
    // so this is only a readable projection for assertions.
    function segmentsText(segments) {
      return segments.map((seg, i) => (i > 0 ? " · " : "") + seg.label + seg.number + " token").join("");
    }

    // Render number+suffix spans: each site gets its own font-size/color span.
    function badgeSegmentNodes(segments) {
      const nodes = [];
      segments.forEach((seg, i) => {
        if (i > 0) nodes.push(jsx("span", { className: "dtc-sep", children: " · " }, "sep" + i));
        nodes.push(jsxs("span", {
          className: "dtc-seg",
          style: siteStyle(seg.font, seg.color),
          children: [seg.label, seg.number, " token"],
        }, seg.kind));
      });
      return nodes;
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
        if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = 0; }
        if (!hover) { setFrame(null); return; }
        const stages = previewStages(props.showInput, props.showOutput);
        const start = previewStartFrame(props.showInput, props.showOutput);
        if (start === null) return;
        let current = start;
        setFrame({ ...current });
        timerRef.current = window.setInterval(() => {
          current = previewAdvance(current, stages);
          setFrame({ ...current });
          if (current.done && timerRef.current) {
            window.clearInterval(timerRef.current);
            timerRef.current = 0;
          }
        }, PREVIEW_TICK_MS);
        return () => {
          if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = 0; }
        };
      }, [hover, mode, props.showInput, props.showOutput]);

      // While hovering: before the effect's first tick lands, render the START
      // frame (zeros), never the idle full figures — so the number visibly
      // climbs from 0, not flash-to-max-then-reset. Not hovering: the idle card
      // shows the complete fake counts, static.
      const activeFrame = hover
        ? (frame || previewStartFrame(props.showInput, props.showOutput))
        : null;
      const segments = previewBadgeSegments(
        mode,
        activeFrame || previewIdleFrame(props.showInput, props.showOutput),
        props.showInput,
        props.showOutput,
        props.sites,
      );

      const thinking = hover && frame !== null && !frame.done;
      // Reuse the real badge markup so the preview paints with the same CSS the
      // counter uses in the chat (two counter-moving shimmer layers). The sweep
      // forces its own tint via `.dsh-where-did-my-tokens-go-sweep * { color:inherit
      // !important }`, so the mirrored segments carry the per-site FONT SIZE
      // (keeping glyph geometry aligned under the travelling mask), not color.
      const badge = segments.length === 0 ? null
        : jsxs("span", {
            "data-dsh-where-did-my-tokens-go": "true",
            "data-dtc-live": thinking ? "true" : "false",
            // Inline structural styles, so the preview degrades exactly like the
            // live badge if the injected stylesheet is ever absent.
            style: BADGE_ROOT_STYLE,
            children: [
              jsx("span", {
                className: "dsh-where-did-my-tokens-go-content",
                style: BADGE_CONTENT_STYLE,
                children: badgeSegmentNodes(segments),
              }),
              thinking ? jsx("span", {
                className: "dsh-where-did-my-tokens-go-dec",
                "aria-hidden": "true",
                style: BADGE_DEC_STYLE,
                children: jsx("span", {
                  className: "dsh-where-did-my-tokens-go-sweep",
                  style: BADGE_SWEEP_STYLE,
                  children: jsx("span", {
                    className: "dsh-where-did-my-tokens-go-content dsh-where-did-my-tokens-go-highlight",
                    style: BADGE_CONTENT_STYLE,
                    children: badgeSegmentNodes(segments),
                  }),
                }),
              }) : null,
            ],
          });

      const perOp = props.sites.perOp;

      return jsxs("div", {
        role: "button",
        // A read-only card is not operable: keep it out of the tab order and
        // off the hover animation, so it never looks pressable but does nothing.
        tabIndex: props.disabled ? -1 : 0,
        "aria-disabled": props.disabled ? "true" : undefined,
        className: "dtc-card" + (props.selected ? " dtc-cardOn" : "") + (props.disabled ? " dtc-cardStatic" : ""),
        "data-dtc-mode": mode,
        "aria-pressed": props.selected ? "true" : "false",
        onMouseEnter: () => { if (!props.disabled) setHover(true); },
        onMouseLeave: () => setHover(false),
        onFocus: () => { if (!props.disabled) setHover(true); },
        onBlur: () => setHover(false),
        onClick: props.disabled ? undefined : () => props.onSelect(mode),
        onKeyDown: props.disabled ? undefined : (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          // A div with role="button" does not swallow the space key the way a
          // native button does; without this, keyboard activation would ALSO
          // scroll the settings panel one screen.
          event.preventDefault();
          props.onSelect(mode);
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
                  jsx("span", {
                    className: "dtc-opUse",
                    style: siteStyle(perOp.font, perOp.color),
                    children: "use " + formatTokens(FAKE_USE, perOp.unit) + " token",
                  }),
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

    const SITES = ["input", "output", "perOp"];

    // The per-site fields behind each switch's gear menu, in form order.
    const SITE_FIELDS = SITES.flatMap((site) => [
      site + "Unit",
      site + "Font",
      site + "Color",
    ]);

    class TokenCounterCardController {
      constructor(scope) {
        this.form = new SettingsFormModel(scope, [
          enumSpec("displayMode"),
          boolSpec("showInput"),
          boolSpec("showOutput"),
          boolSpec("showPerOp"),
          ...SITE_FIELDS.map((field) =>
            /Unit$/.test(field) ? enumSpec(field) : /Font$/.test(field) ? numberSpec(field) : colorSpec(field)
          ),
        ]);
        this.store = this.form.bind(() => this.projection());
      }

      projection() {
        const state = {
          ...this.form.shell(),
          displayMode: this.form.field("displayMode"),
          showInput: this.form.field("showInput"),
          showOutput: this.form.field("showOutput"),
          showPerOp: this.form.field("showPerOp"),
        };
        for (const field of SITE_FIELDS) state[field] = this.form.field(field);
        return state;
      }

      inject() {
        return { hooks: { tokenCounterCard: this.store }, ...this.form.actions() };
      }

      dispose() {
        this.form.dispose();
      }
    }

    const UNIT_CHOICES = ["auto", "K", "M", "G", "T"];

    // A saved/staged unit is only trusted if it names a real choice; anything
    // else (including undefined from an older host build whose Config lacks
    // these fields) reads as auto rather than rendering an empty select.
    function sanitizeUnit(raw) {
      return raw === "auto" || (typeof raw === "string" && Object.hasOwn(UNIT_SCALES, raw)) ? raw : "auto";
    }

    // The dropdown editor behind one switch's gear button: font size, color and
    // unit for THAT site. Field drafts stage through the shared form model, so
    // everything still saves as one batch and discards together.
    function GearPanel(props) {
      const { site, t, state, edit, editable } = props;
      const [open, setOpen] = useState(false);
      // Sanitize for the CONTROL VALUE so an older host (field missing ->
      // String(undefined)) still renders "auto" selected, matching what the
      // preview and the live badge show. The raw draft text stays in the form
      // model; only the display is clamped.
      const unit = sanitizeUnit(state[site + "Unit"].text);
      const color = sanitizeColor(state[site + "Color"].text);
      const font = state[site + "Font"].text;
      return jsxs("div", {
        className: "dtc-gearWrap",
        children: [
          jsx("button", {
            type: "button",
            className: "dtc-gear" + (open ? " dtc-gearOn" : ""),
            "aria-expanded": open ? "true" : "false",
            "aria-label": t("gearLabel"),
            title: t("gearLabel"),
            children: "\u2699", // gear
            onClick: () => setOpen(!open),
          }),
          open ? jsxs("div", {
            className: "dtc-gearPanel",
            role: "group",
            "aria-label": t("gearLabel"),
            children: [
              jsxs("label", {
                className: "dtc-gearField",
                children: [
                  jsx("span", { className: "dtc-gearLabel", children: t("fontField") }),
                  jsx("input", {
                    type: "number",
                    min: "0",
                    max: "96",
                    step: "1",
                    className: "dtc-gearInput",
                    value: font,
                    placeholder: "0",
                    title: t("fontHint"),
                    disabled: !editable,
                    onInput: (event) => edit(site + "Font", event.target.value),
                    onChange: (event) => edit(site + "Font", event.target.value),
                  }),
                ],
              }),
              jsxs("label", {
                className: "dtc-gearField",
                children: [
                  jsx("span", { className: "dtc-gearLabel", children: t("colorField") }),
                  jsxs("span", {
                    className: "dtc-gearColorWrap",
                    children: [
                      jsx("input", {
                        type: "color",
                        className: "dtc-gearColor",
                        // A color input cannot express "inherit": show the
                        // theme-follow sentinel instead of a fake swatch.
                        value: /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#1f2328",
                        disabled: !editable,
                        onInput: (event) => edit(site + "Color", event.target.value),
                        onChange: (event) => edit(site + "Color", event.target.value),
                      }),
                      jsx("button", {
                        type: "button",
                        className: "dtc-gearColorReset" + (color === "" ? " dtc-gearColorResetOn" : ""),
                        title: t("colorNone"),
                        disabled: !editable,
                        onClick: () => edit(site + "Color", ""),
                        children: t("colorNone"),
                      }),
                    ],
                  }),
                ],
              }),
              jsxs("label", {
                className: "dtc-gearField",
                children: [
                  jsx("span", { className: "dtc-gearLabel", children: t("unitField") }),
                  jsx("select", {
                    className: "dtc-gearSelect",
                    value: unit,
                    disabled: !editable,
                    onInput: (event) => edit(site + "Unit", event.target.value),
                    onChange: (event) => edit(site + "Unit", event.target.value),
                    children: UNIT_CHOICES.map((choice) => jsx(
                      "option",
                      { value: choice, children: choice === "auto" ? t("unitAuto") : choice },
                      choice
                    )),
                  }),
                ],
              }),
            ],
          }) : null,
        ],
      });
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

      // Resolve the three sites' staged style (unit/font/color) so the preview
      // cards and the live badge read exactly what the form is showing, before
      // save. Values are sanitized at read time, never trusted raw.
      const sites = {};
      for (const site of SITES) {
        sites[site] = {
          unit: sanitizeUnit(state[site + "Unit"].text),
          font: sanitizeFont(state[site + "Font"].text),
          color: sanitizeColor(state[site + "Color"].text),
        };
      }

      // The platform `Switch` renders only the toggle itself (its `label` prop
      // is an aria-label), so each row carries its own visible caption. The gear
      // button beside it dropdown-expands that site's font/color/unit editor.
      const switchRow = (site, caption, checked, onToggle) =>
        jsxs("div", {
          className: "dtc-switchRow",
          children: [
            jsx("span", { className: "dtc-switchLabel", children: caption }),
            jsxs("div", {
              className: "dtc-switchCtl",
              children: [
                jsx(GearPanel, {
                  site,
                  t: tCard,
                  state,
                  edit: props.edit,
                  editable,
                }),
                jsx(Switch, {
                  checked,
                  onChange: onToggle,
                  label: caption,
                  disabled: !editable,
                }),
              ],
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
        sites,
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
                  switchRow("input", tCard("showInput"), showInput, (checked) =>
                    props.edit("showInput", checked ? "true" : "false")
                  ),
                  switchRow("output", tCard("showOutput"), showOutput, (checked) =>
                    props.edit("showOutput", checked ? "true" : "false")
                  ),
                  switchRow("perOp", tCard("showPerOp"), showPerOp, (checked) =>
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
        className: "dsh-where-did-my-tokens-go-section",
        children: [
          jsx("h2", {
            className: "dsh-where-did-my-tokens-go-sectionTitle",
            children: tCard("title"),
          }),
          jsx("p", {
            className: "dsh-where-did-my-tokens-go-sectionIntro",
            children: tCard("description"),
          }),
          form,
        ],
      });
    }

    // ── DOM helpers ──────────────────────────────────────────────────
    const STYLE_ID = "dsh-where-did-my-tokens-go-style";
    // The host's module system claims every UNTAGGED <style> for whichever plugin
    // materializes next (`claimStyles`) and deletes `style[data-plugin=<id>]`
    // when that plugin is invalidated or pruned (`removeOwnedStyles`). An
    // untagged stylesheet can therefore be adopted by an unrelated plugin and
    // deleted during ITS hot reload — which silently strips the badge down to a
    // plain inline span whose decorative layer renders as a second, visible copy
    // of the counter. Tagging the sheet as ours makes the host remove it only
    // when THIS plugin is invalidated, which is exactly when apply() re-runs and
    // re-injects it.
    const STYLE_OWNER = "dsh-where-did-my-tokens-go";

    // Idempotent, and called both at apply time and on every badge sync: a host
    // reload can drop the injected <style>, and without it the badge's decorative
    // layer would degrade into a second, visible copy of the counter.
    function ensureStyle() {
      if (typeof document === "undefined" || !document.head) return;
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.setAttribute("data-plugin", STYLE_OWNER);
      style.textContent = buildStyleText();
      try { document.head.appendChild(style); } catch (e) {}
    }

    function buildStyleText() {
      return [
        // ── settings layout: light, tidy, adaptive ──────────────────
        // White cards on a pale-grey field, with a two-column grid that
        // collapses to one column on narrow panels (plugins page, small windows).
        ".dtc-layout{display:flex;flex-direction:column;gap:16px;}",
        ".dtc-head{display:flex;flex-direction:column;gap:2px;}",
        // The preview head sits on the HOST panel background (not inside a light
        // card), so it follows the theme. The switches heading reuses the class
        // but lives on a fixed #f6f8fa panel, so it keeps the fixed dark ink.
        ".dtc-headTitle{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}",
        ".dtc-switches .dtc-headTitle{color:#1f2328;}",
        ".dtc-headHint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);}",
        ".dtc-previews{display:flex;flex-direction:column;gap:10px;}",
        ".dtc-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;}",
        // one preview card
        ".dtc-card{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;cursor:pointer;text-align:left;font:inherit;",
        " background:#ffffff;border:1px solid #e5e9ef;color:#1f2328;",
        " transition:border-color .15s ease,box-shadow .15s ease;}",
        // Hover lift applies only to UNSELECTED cards: `.dtc-card:hover` alone
        // (specificity 0,2,0) would out-rank `.dtc-cardOn` (0,1,0) and erase the
        // blue border + ring the moment the pointer rests on the selected card.
        ".dtc-card:not(.dtc-cardOn):hover{border-color:#c9d3e0;box-shadow:0 2px 10px rgba(31,35,40,.06);}",
        ".dtc-card:focus-visible{outline:2px solid #2563eb;outline-offset:2px;}",
        // read-only deployment: the card shows the scene but refuses the gesture.
        // Static unselected cards get no lift at all; the selected card keeps its
        // blue highlight in every state.
        ".dtc-cardStatic{cursor:default;}",
        ".dtc-cardStatic:not(.dtc-cardOn):hover{border-color:#e5e9ef;box-shadow:none;}",
        // Compound (0,2,0) so the selection ring beats the baseline .dtc-card
        // (0,1,0) by SPECIFICITY, not by source order — a later reshuffle of
        // these rules can then never silently erase the blue border.
        ".dtc-card.dtc-cardOn{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.10);}",
        ".dtc-cardTitle{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#57606a;}",
        ".dtc-cardDot{margin-left:auto;width:8px;height:8px;border-radius:50%;background:transparent;border:1px solid #c9d3e0;}",
        ".dtc-cardOn .dtc-cardDot{background:#2563eb;border-color:#2563eb;}",
        // the miniature transcript inside a card
        // overflow:hidden clips any oversized child to the bubble box — a badge
        // whose nowrap text cannot shrink would otherwise paint past the card
        // border onto the dark settings background, where the border cut reads
        // as a duplicated fragment of the counter text.
        ".dtc-chat{display:flex;flex-direction:column;gap:0;border-radius:8px;background:#f6f8fa;border:1px solid #e5e9ef;padding:10px 12px;min-width:0;overflow:hidden;}",
        ".dtc-opRow{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:#57606a;min-width:0;}",
        ".dtc-opIcon{flex:none;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10px;color:#8b949e;}",
        ".dtc-opLabel{white-space:nowrap;}",
        ".dtc-opUse{white-space:nowrap;opacity:.62;font-variant-numeric:tabular-nums;}",
        ".dtc-divider{height:1px;background:#e5e9ef;margin:8px 0;}",
        // flex-wrap:wrap — the badge is a flex item with min-width:0, so on a
        // narrow card it gets compressed below the width of its own nowrap text
        // and the overflow escapes the row; letting it wrap to its own line
        // keeps the full counter readable instead of spilling it sideways.
        ".dtc-thinkRow{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;line-height:18px;color:#2563eb;min-width:0;}",
        ".dtc-thinkDot{flex:none;width:6px;height:6px;border-radius:50%;background:#2563eb;opacity:.65;}",
        ".dtc-thinkLabel{white-space:nowrap;}",
        // the badge inside the preview: same layered CSS as the real chat badge,
        // recolored for the light card (blue text, pale-blue sweep band).
        ".dtc-card [data-dsh-where-did-my-tokens-go]{margin-left:2px;color:#2563eb;}",
        ".dtc-card [data-dsh-where-did-my-tokens-go] .dsh-where-did-my-tokens-go-sweep{color:#9ecbff;}",
        // switches column
        ".dtc-switches{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;background:#f6f8fa;border:1px solid #e5e9ef;}",
        ".dtc-switchRow{display:flex;align-items:center;justify-content:space-between;gap:12px;}",
        ".dtc-switchCtl{display:flex;align-items:center;gap:6px;}",
        ".dtc-switchLabel{font-size:13px;line-height:1.5;color:#1f2328;}",
        // gear button + dropdown editor (font size / color / unit for one site)
        ".dtc-gearWrap{position:relative;display:inline-flex;}",
        ".dtc-gear{appearance:none;width:24px;height:24px;border-radius:6px;border:1px solid transparent;background:transparent;",
        " color:#57606a;font-size:14px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;}",
        ".dtc-gear:hover{background:#eaeef3;border-color:#d6dee8;}",
        ".dtc-gear:focus-visible{outline:2px solid #2563eb;outline-offset:1px;}",
        ".dtc-gearOn{background:#eaeef3;border-color:#d6dee8;color:#2563eb;}",
        ".dtc-gearPanel{position:absolute;top:calc(100% + 6px);right:0;z-index:30;display:flex;flex-direction:column;gap:8px;",
        " width:210px;padding:10px;border-radius:10px;background:#ffffff;border:1px solid #d6dee8;box-shadow:0 6px 20px rgba(31,35,40,.12);}",
        ".dtc-gearField{display:flex;flex-direction:column;gap:3px;}",
        ".dtc-gearLabel{font-size:11px;color:#57606a;}",
        ".dtc-gearInput,.dtc-gearSelect{font:inherit;font-size:12px;color:#1f2328;background:#f6f8fa;border:1px solid #d6dee8;",
        " border-radius:6px;padding:3px 6px;width:100%;box-sizing:border-box;}",
        ".dtc-gearInput:disabled,.dtc-gearSelect:disabled{opacity:.55;cursor:default;}",
        ".dtc-gearColorWrap{display:flex;align-items:center;gap:6px;}",
        ".dtc-gearColor{flex:none;width:28px;height:24px;padding:0;border:1px solid #d6dee8;border-radius:6px;background:#f6f8fa;cursor:pointer;}",
        ".dtc-gearColor:disabled{opacity:.55;cursor:default;}",
        ".dtc-gearColorReset{font:inherit;font-size:11px;color:#57606a;background:#f6f8fa;border:1px solid #d6dee8;border-radius:6px;",
        " padding:2px 8px;cursor:pointer;flex:1;}",
        ".dtc-gearColorReset:hover{border-color:#c9d3e0;}",
        ".dtc-gearColorResetOn{color:#2563eb;border-color:#2563eb;background:#eef4ff;}",
        ".dtc-gearColorReset:disabled{opacity:.55;cursor:default;}",
        // badge segments (preview + live share the markup; per-site style rides inline)
        ".dtc-sep{opacity:.6;}",
        // standalone settings section (own heading + description)
        ".dsh-where-did-my-tokens-go-section{display:flex;flex-direction:column;gap:12px;max-width:760px;}",
        ".dsh-where-did-my-tokens-go-sectionTitle{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary);}",
        ".dsh-where-did-my-tokens-go-sectionIntro{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary);}",
        // ── the real chat badge (after the deep-thinking indicator) ───
        // Inherit the row's own font and color, and let the row's shimmer
        // variable drive the highlight: `.xz4KEq_running` sets
        // `--dsw-alias-label-shimmer: var(--dsw-alias-label-deep-diving-shimmer)`
        // and `color: var(--dsw-alias-label-deep-diving)`, so the counter reads
        // as part of the same sentence instead of a second, differently styled one.
        "[data-dsh-where-did-my-tokens-go]{position:relative;display:inline-grid;width:max-content;max-width:100%;min-width:0;vertical-align:top;color:inherit;font:inherit;white-space:nowrap;user-select:none;font-variant-numeric:tabular-nums;}",
        "[data-dsh-where-did-my-tokens-go] .dsh-where-did-my-tokens-go-content{display:flex;align-items:center;min-width:0;color:inherit;}",
        // Mirror of TextShimmer.module.css: the mask travels one way, the text
        // the other, so the glyphs never move and only a light band crosses them.
        "[data-dsh-where-did-my-tokens-go] .dsh-where-did-my-tokens-go-dec{position:absolute;inset:0;overflow:clip;pointer-events:none;user-select:none;}",
        "[data-dsh-where-did-my-tokens-go] .dsh-where-did-my-tokens-go-sweep{position:absolute;inset:0;overflow:hidden;color:var(--dsw-alias-label-shimmer,#fff);-webkit-mask-image:linear-gradient(105deg,transparent 0%,#000 40% 60%,transparent 100%);mask-image:linear-gradient(105deg,transparent 0%,#000 40% 60%,transparent 100%);transform:translateX(-100%);}",
        "[data-dsh-where-did-my-tokens-go] .dsh-where-did-my-tokens-go-sweep,[data-dsh-where-did-my-tokens-go] .dsh-where-did-my-tokens-go-highlight{animation-name:dsh-where-did-my-tokens-go-sweep;animation-duration:1.5s;animation-delay:.3s;animation-timing-function:steps(48,end);animation-iteration-count:infinite;}",
        "[data-dsh-where-did-my-tokens-go] .dsh-where-did-my-tokens-go-highlight{width:100%;height:100%;transform:translateX(100%);animation-name:dsh-where-did-my-tokens-go-highlight;}",
        "[data-dsh-where-did-my-tokens-go] .dsh-where-did-my-tokens-go-sweep *{color:inherit !important;}",
        "@keyframes dsh-where-did-my-tokens-go-sweep{0%{transform:translateX(-100%);}66.6667%,100%{transform:translateX(100%);}}",
        "@keyframes dsh-where-did-my-tokens-go-highlight{0%{transform:translateX(100%);}66.6667%,100%{transform:translateX(-100%);}}",
        "@media (prefers-reduced-motion: reduce){[data-dsh-where-did-my-tokens-go] .dsh-where-did-my-tokens-go-dec{display:none;}[data-dsh-where-did-my-tokens-go] .dsh-where-did-my-tokens-go-sweep,[data-dsh-where-did-my-tokens-go] .dsh-where-did-my-tokens-go-highlight{animation:none;}}",
        // per-operation "use N token" (matches the row's own text style)
        "[data-dsh-use-token]{margin-left:6px;font-size:12px;font-weight:normal;line-height:inherit;color:inherit;opacity:.62;white-space:nowrap;}",
      ].join("\n");
    }

    // The blue "深度思考/深度求索" indicator is a hardcoded RunningStatus
    // (`.xz4KEq_running[data-chat-running]`) whose last child holds the whale
    // tail + shimmer text. We append our counter inside its content container.
    function findRunning() {
      if (typeof document === "undefined") return null;
      return document.querySelector('[data-chat-running]');
    }

    function findAnchor() {
      const running = findRunning();
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
    //   span[data-dsh-where-did-my-tokens-go]
    //     span.content            (real text)
    //     span.dec[aria-hidden]   (overlay, inert)
    //       span.sweep            (travelling mask)
    //         span.content.highlight (mirrored text, counter-travelling)
    // Structural properties are ALSO applied inline, from this one source, both
    // by the imperative badge and by the React preview. The injected stylesheet
    // carries the animation and theming, but if it ever goes missing (a host
    // reload that drops our <style>, a re-render into another root) the
    // decorative layer must still be taken out of flow and clipped — otherwise
    // it degrades into a second, plainly visible copy of the counter glued to
    // the first one.
    const BADGE_ROOT_STYLE = {
      position: "relative", display: "inline-grid", width: "max-content",
      maxWidth: "100%", minWidth: "0", verticalAlign: "top",
      whiteSpace: "nowrap", userSelect: "none",
    };
    const BADGE_CONTENT_STYLE = { display: "flex", alignItems: "center", minWidth: "0", color: "inherit" };
    const BADGE_DEC_STYLE = { position: "absolute", inset: "0", overflow: "clip", pointerEvents: "none", userSelect: "none" };
    const BADGE_SWEEP_STYLE = { position: "absolute", inset: "0", overflow: "hidden" };

    function applyBadgeLayout(root) {
      Object.assign(root.style, BADGE_ROOT_STYLE);
      const content = root.firstElementChild;
      if (content) Object.assign(content.style, BADGE_CONTENT_STYLE);
      const dec = root.querySelector(".dsh-where-did-my-tokens-go-dec");
      if (dec) Object.assign(dec.style, BADGE_DEC_STYLE);
      const sweep = root.querySelector(".dsh-where-did-my-tokens-go-sweep");
      if (sweep) Object.assign(sweep.style, BADGE_SWEEP_STYLE);
    }

    function buildBadge(segments) {
      const root = document.createElement("span");
      root.setAttribute("data-dsh-where-did-my-tokens-go", "true");

      const content = document.createElement("span");
      content.className = "dsh-where-did-my-tokens-go-content";

      const decoration = document.createElement("span");
      decoration.className = "dsh-where-did-my-tokens-go-dec";
      decoration.setAttribute("aria-hidden", "true");
      decoration.setAttribute("inert", "");

      const sweep = document.createElement("span");
      sweep.className = "dsh-where-did-my-tokens-go-sweep";

      const inner = document.createElement("span");
      inner.className = "dsh-where-did-my-tokens-go-content dsh-where-did-my-tokens-go-highlight";

      sweep.appendChild(inner);
      decoration.appendChild(sweep);
      root.appendChild(content);
      root.appendChild(decoration);
      fillBadge(root, segments);
      applyBadgeLayout(root);
      return root;
    }

    // Write one layer's segments: ` · ` separators plus a styled span per site
    // (font-size / color when set, otherwise inherit the row). Both layers get
    // identical children so the sweep mirrors the real glyphs exactly.
    function fillLayer(layer, segments) {
      while (layer.firstChild) layer.removeChild(layer.firstChild);
      segments.forEach((seg, i) => {
        if (i > 0) {
          const sep = document.createElement("span");
          sep.className = "dtc-sep";
          sep.textContent = " · ";
          layer.appendChild(sep);
        }
        const node = document.createElement("span");
        node.className = "dtc-seg";
        node.dataset.dtcSite = seg.kind;
        if (seg.font > 0) node.style.fontSize = seg.font + "px";
        if (seg.color) node.style.color = seg.color;
        node.textContent = seg.label + seg.number + " token";
        layer.appendChild(node);
      });
    }

    function fillBadge(root, segments) {
      fillLayer(root.firstElementChild, segments);
      const highlight = root.querySelector(".dsh-where-did-my-tokens-go-highlight");
      if (highlight) fillLayer(highlight, segments);
    }

    // The badge's flat text (for change detection): rebuild only when it or a
    // segment's style actually changed.
    function badgeKey(segments) {
      return segments.map((seg) => seg.kind + ":" + seg.number + ":" + seg.font + ":" + seg.color).join("|");
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
          "dsh-where-did-my-tokens-go: locale"
        );
      }

      ensureStyle();

      // ── settings surfaces ──
      // The harness exposes several seats for a plugin's own configuration, and
      // its slot contract reserves `plugins.item` for the official settings
      // pages: "a bundle's configuration belongs in `plugins.bundle.config` or
      // `plugins.row.config` instead". We mount the same controller into the
      // seats we want (a slot that is never declared simply never runs):
      //   1. `plugins.bundle.config`, keyed by the bundle's package name — the
      //      config section on this plugin's page in the Plugins panel;
      //   2. `settings.section` — an own entry in the Settings panel's
      //      navigation, the primary place users edit these options;
      //   3. `plugins.item` — the card in the Plugins panel's Official group.
      // `settings.plugins.tab` (a page beside the built-in inventory in
      // Settings → 内置插件) is deliberately NOT registered: it would duplicate
      // the `settings.section` page inside the very same Settings panel.
      // All of them are gated on the Host serving our settings namespace.
      let card = null;
      if (configForms && slots && slots.inject) {
        const scope = configForms.get(CONFIG_NS);
        card = new TokenCounterCardController(scope);
        ctx.effect(() => () => card.dispose(), "dsh-where-did-my-tokens-go: card dispose");
        const bundleConfigOptions = {
          name: "plugins.bundle.config",
          key: CONFIG_NS,
          order: 30,
          label: () => t("title"),
          locale: LOCALE_NS,
          inject: () => card.inject(),
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
          "dsh-where-did-my-tokens-go: settings surfaces"
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
        const fallback = {
          displayMode: "merged", showInput: true, showOutput: true, showPerOp: true,
          inputUnit: "auto", outputUnit: "auto", perOpUnit: "auto",
          inputFont: 0, outputFont: 0, perOpFont: 0,
          inputColor: "", outputColor: "", perOpColor: "",
        };
        try {
          const scope = configForms && configForms.get(CONFIG_NS);
          const snap = scope && scope.getSnapshot ? scope.getSnapshot() : null;
          const v = snap && snap.value;
          if (!v) return fallback;
          return {
            displayMode: v.displayMode ? v.displayMode : "merged",
            showInput: v.showInput !== false,
            showOutput: v.showOutput !== false,
            showPerOp: v.showPerOp !== false,
            // Saved per-site styling (NOT staged drafts — the form's save is the
            // single point where drafts become what the chat renders).
            inputUnit: sanitizeUnit(v.inputUnit),
            outputUnit: sanitizeUnit(v.outputUnit),
            perOpUnit: sanitizeUnit(v.perOpUnit),
            inputFont: sanitizeFont(v.inputFont),
            outputFont: sanitizeFont(v.outputFont),
            perOpFont: sanitizeFont(v.perOpFont),
            inputColor: sanitizeColor(v.inputColor),
            outputColor: sanitizeColor(v.outputColor),
            perOpColor: sanitizeColor(v.perOpColor),
          };
        } catch (e) {
          return fallback;
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

      // Live badge as segments so each site keeps its own unit/font/color. The
      // cfg unit applies to the number; font/color ride on the segment span.
      function seg(kind, value) {
        const site = kind === "in"
          ? { unit: cfg.inputUnit, font: cfg.inputFont, color: cfg.inputColor }
          : { unit: cfg.outputUnit, font: cfg.outputFont, color: cfg.outputColor };
        return { kind, label: kind + " ", number: formatTokens(value, site.unit), font: site.font, color: site.color };
      }

      function buildBadgeSegments(s) {
        if (!s) return [];
        const outVal = s.outTokens != null ? s.outTokens : estimate(s);
        // Input count precedence: the provider's settled figure for this request,
        // then the harness's live priced prompt, then the last input we learned
        // (a later step's prefill before its own projection lands).
        const inVal = s.inTokens != null ? s.inTokens : (readPressure() ?? s.lastIn);

        if (cfg.displayMode === "split") {
          // Fixed: both counts, for the whole turn.
          const parts = [];
          if (cfg.showInput && inVal != null) parts.push(seg("in", inVal));
          if (cfg.showOutput) parts.push(seg("out", outVal));
          return parts;
        }

        // Merged: the label swaps, it never stacks. The input count stands while
        // the request is being prepared; once the answer starts streaming it
        // becomes the output count. If no input number exists yet (a deployment
        // whose token-meter projection has not landed), fall back to showing the
        // output count rather than blanking the row: the indicator is running and
        // an honest 0 beats a missing counter.
        if (!(s.phase === "output" || s.phase === "reasoning" || outVal > 0)) {
          if (cfg.showInput && inVal != null) return [seg("in", inVal)];
          return cfg.showOutput ? [seg("out", outVal)] : [];
        }
        // Answering: the output total.
        return cfg.showOutput ? [seg("out", outVal)] : [];
      }

      const syncBadge = () => {
        raf = 0;
        // The stylesheet is re-asserted every sync: it is the only thing that
        // keeps the decorative layer from reading as a second copy of the text,
        // so a host reload that dropped our <style> must not leave the badge
        // degraded until the next full plugin mount.
        ensureStyle();
        const anchor = findAnchor();
        // While the row is running we always have something to price: a session
        // that has not produced an event we recognise yet still shows the input
        // count, so the prefill phase is never blank.
        const s = anchor
          ? (activeId !== undefined ? states.get(activeId) : undefined) || makeState()
          : undefined;
        const segments = buildBadgeSegments(s);
        const key = badgeKey(segments);

        if (anchor && segments.length) {
          // Defensive sweep across the WHOLE running row: if the row was
          // re-created, or an earlier badge was left in a different container
          // (the content box moved, the fallback anchor was used), exactly one
          // badge may remain — otherwise the counter would be painted twice.
          const running = findRunning();
          const strays = (running || anchor).querySelectorAll("[data-dsh-where-did-my-tokens-go]");
          for (const stray of strays) if (stray !== counterSpan) stray.remove();
          if (!counterSpan || counterSpan.parentNode !== anchor) {
            if (counterSpan && counterSpan.parentNode) counterSpan.remove();
            counterSpan = buildBadge(segments);
            counterSpan.dataset.dtcKey = key;
            anchor.appendChild(counterSpan);
          } else if (counterSpan.dataset.dtcKey !== key) {
            // Numbers or per-site styles changed: rebuild both layers in place.
            fillBadge(counterSpan, segments);
            counterSpan.dataset.dtcKey = key;
          }
          applyBadgeLayout(counterSpan);
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
          const text = "use " + formatTokens(total, cfg.perOpUnit) + " token";
          if (!span) {
            span = document.createElement("span");
            span.setAttribute("data-dsh-use-token", "true");
            row.btn.appendChild(span);
          }
          // Per-site font/color ride inline; 0/"" keep the row's inherited style.
          if (cfg.perOpFont > 0) span.style.fontSize = cfg.perOpFont + "px";
          else span.style.removeProperty("font-size");
          if (cfg.perOpColor) span.style.color = cfg.perOpColor;
          else span.style.removeProperty("color");
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
            if (chunk.type === "text-delta") {
              // The visible answer. Its text is part of the output total, and its
              // arrival ends the thinking phase.
              countDelta(s, chunk.text);
              s.phase = "output";
              dirty = true;
            } else if (chunk.type === "reasoning-delta") {
              // Thinking text: counted into the output total (the provider's
              // outputTokens includes it).
              countDelta(s, chunk.text);
              if (s.phase === "input") s.phase = "reasoning";
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
        "dsh-where-did-my-tokens-go: cleanup"
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
      stages: previewStages,
      badgeSegments: previewBadgeSegments,
      segmentsText,
      FAKE_IN,
      FAKE_OUT,
      FAKE_USE,
    };
    // Unit/style helpers, exposed for tests (pure functions).
    exports.tokens = {
      format: formatTokens,
      sanitizeFont,
      sanitizeColor,
      sanitizeUnit,
      siteStyle,
      UNIT_SCALES,
    };
    return module.exports;
  }
});
