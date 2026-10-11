window.__ModuleLoader__.load({
  id: "dsh-token-counter",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ── dependencies ─────────────────────────────────────────────────
    const reactJsx = require("react/jsx-runtime");
    const { jsx, jsxs } = reactJsx;
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const { SettingsForm, SettingsFormModel, SegmentedControl, Switch } = primitives;

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

    function makeState() {
      return {
        cjk: 0,
        latin: 0,
        phase: "input",      // "input" -> "output" once the first output delta lands
        inTokens: null,      // authoritative inputTokens (settle-time)
        outTokens: null,     // authoritative outputTokens (settle-time)
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
        "在深度思考指示器后实时显示输入 / 输出 token，并在每个已完成的操作后显示该轮消耗的 token。",
      displayMode: "显示模式",
      displayModeMerged: "合并模式",
      displayModeSplit: "分开模式",
      showInput: "显示输入 token（in）",
      showOutput: "显示输出 token（out）",
      showPerOp: "在已完成操作后显示消耗 token（use）",
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
        "Shows live input/output tokens after the deep-thinking indicator, and per-operation token usage after each completed step.",
      displayMode: "Display mode",
      displayModeMerged: "Merged",
      displayModeSplit: "Split",
      showInput: "Show input tokens (in)",
      showOutput: "Show output tokens (out)",
      showPerOp: "Show consumed tokens after completed operations (use)",
      save: "Save",
      saving: "Saving…",
      discard: "Discard",
      readOnly: "Read only",
      unavailable: "Settings unavailable",
      saveFailed: "Save failed",
    };

    // ── settings card ────────────────────────────────────────────────
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

      const children = state.available
        ? jsxs(
            "div",
            { className: "dsh-token-counter-settings" },
            jsx(SegmentedControl, {
              id: "dsh-token-counter-display-mode",
              label: tCard("displayMode"),
              value: state.displayMode.text,
              options: [
                { value: "merged", label: tCard("displayModeMerged") },
                { value: "split", label: tCard("displayModeSplit") },
              ],
              onChange: (value) => props.edit("displayMode", value),
              disabled: !state.writable,
            }),
            jsx(Switch, {
              checked: state.showInput.text === "true",
              onChange: (checked) => props.edit("showInput", checked ? "true" : "false"),
              label: tCard("showInput"),
              disabled: !state.writable,
            }),
            jsx(Switch, {
              checked: state.showOutput.text === "true",
              onChange: (checked) => props.edit("showOutput", checked ? "true" : "false"),
              label: tCard("showOutput"),
              disabled: !state.writable,
            }),
            jsx(Switch, {
              checked: state.showPerOp.text === "true",
              onChange: (checked) => props.edit("showPerOp", checked ? "true" : "false"),
              label: tCard("showPerOp"),
              disabled: !state.writable,
            })
          )
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
      return jsxs(
        "div",
        { className: "dsh-token-counter-section" },
        jsx("h2", {
          className: "dsh-token-counter-sectionTitle",
          children: tCard("title"),
        }),
        jsx("p", {
          className: "dsh-token-counter-sectionIntro",
          children: tCard("description"),
        }),
        form
      );
    }

    // ── DOM helpers ──────────────────────────────────────────────────
    const STYLE_ID = "dsh-token-counter-style";

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = [
        // settings card layout
        ".dsh-token-counter-settings{display:flex;flex-direction:column;gap:12px;}",
        // standalone settings section (own heading + description)
        ".dsh-token-counter-section{display:flex;flex-direction:column;gap:12px;max-width:720px;}",
        ".dsh-token-counter-sectionTitle{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary);}",
        ".dsh-token-counter-sectionIntro{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary);}",
        // counter badge (after the deep-thinking indicator)
        "[data-dsh-token-counter]{position:relative;display:inline-block;margin-left:8px;font-size:12px;line-height:inherit;font-variant-numeric:tabular-nums;white-space:nowrap;user-select:none;}",
        "[data-dsh-token-counter] .dsh-token-counter-base{color:var(--dsw-alias-label-secondary,#6b7280);}",
        "[data-dsh-token-counter] .dsh-token-counter-sweep{position:absolute;inset:0;color:var(--dsw-alias-label-shimmer,#ffffff);-webkit-mask-image:linear-gradient(105deg,transparent 0%,#000 40%,#000 60%,transparent 100%);mask-image:linear-gradient(105deg,transparent 0%,#000 40%,#000 60%,transparent 100%);transform:translateX(-100%);animation:dsh-token-counter-sweep 1.5s steps(48,end) infinite;animation-delay:.3s;}",
        "@keyframes dsh-token-counter-sweep{0%{transform:translateX(-100%);}66.67%,100%{transform:translateX(100%);}}",
        "@media (prefers-reduced-motion: reduce){[data-dsh-token-counter] .dsh-token-counter-sweep{animation:none;display:none;}}",
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

    // Build the shimmer badge using the DOM API (testable, no innerHTML):
    //   span[data-dsh-token-counter] > span.base (real text) + span.sweep (overlay)
    function buildBadge(text) {
      const root = document.createElement("span");
      root.setAttribute("data-dsh-token-counter", "true");
      const base = document.createElement("span");
      base.className = "dsh-token-counter-base";
      base.textContent = text;
      const sweep = document.createElement("span");
      sweep.className = "dsh-token-counter-sweep";
      sweep.setAttribute("aria-hidden", "true");
      sweep.textContent = text;
      root.appendChild(base);
      root.appendChild(sweep);
      return root;
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
      const turnUsage = new Map(); // "sessionId:turn" -> { in, out } cumulative
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

      function buildBadgeText(s) {
        if (!s) return "";
        const outVal = s.outTokens != null ? s.outTokens : estimate(s);
        const outText = "out " + outVal + " token";
        const inText = s.inTokens != null ? "in " + s.inTokens + " token" : null;

        if (cfg.displayMode === "split") {
          const parts = [];
          if (cfg.showInput && inText) parts.push(inText);
          if (cfg.showOutput) parts.push(outText);
          return parts.join(" · ");
        }

        // merged: show output while generating; show input only in the brief
        // pre-generation window when it is already known.
        const outputting = s.phase === "output" || outVal > 0;
        if (outputting) return cfg.showOutput ? outText : "";
        return cfg.showInput && inText ? inText : cfg.showOutput ? outText : "";
      }

      const syncBadge = () => {
        raf = 0;
        const anchor = findAnchor();
        const s = activeId !== undefined ? states.get(activeId) : undefined;
        const text = buildBadgeText(s);

        if (anchor && text) {
          if (!counterSpan || counterSpan.parentNode !== anchor) {
            if (counterSpan && counterSpan.parentNode) counterSpan.remove();
            counterSpan = buildBadge(text);
            anchor.appendChild(counterSpan);
          } else {
            counterSpan.children[0].textContent = text;
            counterSpan.children[1].textContent = text;
          }
        } else if (counterSpan && counterSpan.parentNode) {
          counterSpan.remove();
          counterSpan = null;
        }
      };

      const syncPerOp = () => {
        if (typeof document === "undefined") return;
        const buttons = document.querySelectorAll("button[data-process-activity]");
        for (const btn of buttons) {
          const closed = !btn.querySelector("[data-shimmer]");
          let span = btn.querySelector("[data-dsh-use-token]");
          if (!closed) {
            if (span) span.remove();
            continue;
          }
          let turn;
          const group = btn.closest("[data-chat-turn]");
          if (group) {
            const raw = group.getAttribute("data-chat-turn");
            const n = Number(raw);
            if (Number.isFinite(n)) turn = n;
          }
          if (!span) {
            span = document.createElement("span");
            span.setAttribute("data-dsh-use-token", "true");
            btn.appendChild(span);
          }
          const acc =
            turn !== undefined && activeId !== undefined
              ? turnUsage.get(activeId + ":" + turn) || { in: 0, out: 0, total: 0 }
              : { in: 0, out: 0, total: 0 };
          // Prefer the provider's authoritative totalTokens; fall back to
          // input+output when a provider omits totalTokens.
          const useVal = acc.total > 0 ? acc.total : acc.in + acc.out;
          span.textContent = "use " + useVal + " token";
        }
      };

      const scheduleSync = () => {
        if (raf) return;
        raf = typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(syncBadge)
          : setTimeout(syncBadge, 16);
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
              if (typeof chunk.usage.inputTokens === "number") s.inTokens = chunk.usage.inputTokens;
              if (typeof chunk.usage.outputTokens === "number") s.outTokens = chunk.usage.outputTokens;
              dirty = true;
            }
          } else if (ty === "step/start" || ty === "turn/start") {
            s = makeState();
            dirty = true;
          } else if (ty === "assistant/message") {
            const data = ev.data || {};
            const usage = data.usage;
            if (usage) {
              if (typeof usage.inputTokens === "number") s.inTokens = usage.inputTokens;
              if (typeof usage.outputTokens === "number") s.outTokens = usage.outputTokens;
              const turn = data.turn;
              if (turn !== undefined) {
                const key = activeId + ":" + turn;
                const acc = turnUsage.get(key) || { in: 0, out: 0, total: 0 };
                acc.out += typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
                acc.in += typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
                acc.total += typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
                turnUsage.set(key, acc);
              }
              dirty = true;
            }
          }
        }

        if (dirty || mode === "replace") {
          states.set(activeId, s);
          scheduleSync();
        }
      };

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
    return module.exports;
  }
});
