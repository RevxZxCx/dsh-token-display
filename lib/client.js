window.__ModuleLoader__.load({
  id: "dsh-token-counter",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ── token estimation ─────────────────────────────────────────────
    // The provider stream carries TEXT deltas, not per-token counts. The
    // authoritative `outputTokens` only lands on `assistant/message` at the
    // end. For a realtime rolling number we estimate client-side:
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

    function makeCounts() {
      return { cjk: 0, latin: 0 };
    }

    // ── DOM helpers ──────────────────────────────────────────────────
    const STYLE_ID = "dsh-token-counter-style";

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = [
        '[data-dsh-token-counter]{',
        '  margin-left:8px;',
        '  font-size:12px;',
        '  line-height:inherit;',
        '  color:var(--dsw-alias-state-business-primary,#4c6fff);',
        '  font-variant-numeric:tabular-nums;',
        '  white-space:nowrap;',
        '  user-select:none;',
        '}'
      ].join("\n");
      document.head.appendChild(style);
    }

    // The blue "深度思考/深度求索" indicator is a hardcoded RunningStatus
    // component (`.xz4KEq_running[data-chat-running]`) with a last span child
    // holding the whale tail + shimmer text. We append our counter inside it.
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

    // ── plugin entry ─────────────────────────────────────────────────
    function apply(ctx) {
      const sessions = ctx.get("sessions");
      if (!sessions || typeof document === "undefined") return;

      ensureStyle();

      const counts = new Map(); // sessionId -> {cjk, latin}
      let activeId;
      let stopEvent = null;
      let stopList = null;
      let counterSpan = null;
      let raf = 0;
      let pollTimer = null;

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

      const reset = () => ({ cjk: 0, latin: 0 });

      const syncDom = () => {
        raf = 0;
        const anchor = findAnchor();
        if (!anchor) {
          counterSpan = null;
          return;
        }
        if (!counterSpan || counterSpan.parentNode !== anchor) {
          if (counterSpan && counterSpan.parentNode) counterSpan.remove();
          counterSpan = document.createElement("span");
          counterSpan.setAttribute("data-dsh-token-counter", "true");
          anchor.appendChild(counterSpan);
        }
        const c = activeId !== undefined ? counts.get(activeId) : undefined;
        const n = c ? estimate(c) : 0;
        counterSpan.textContent = n + " token";
      };

      const scheduleSync = () => {
        if (raf) return;
        raf = typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(syncDom)
          : setTimeout(syncDom, 16);
      };

      const handleEntries = (entries, mode) => {
        let c = counts.get(activeId);
        if (mode === "replace" || c === undefined) c = reset();
        let dirty = false;
        for (const entry of entries) {
          const ev = entry && entry.event;
          if (!ev) continue;
          const t = ev.type;
          if (t === "assistant/live-chunk") {
            const chunk = ev.data && ev.data.chunk;
            if (chunk && (chunk.type === "text-delta" || chunk.type === "reasoning-delta")) {
              countDelta(c, chunk.text);
              dirty = true;
            }
          } else if (t === "step/start" || t === "turn/start") {
            c = reset();
            dirty = true;
          }
        }
        if (dirty || mode === "replace") {
          counts.set(activeId, c);
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

      stopList = sessions.list.subscribe(() => {
        try { attach(currentId()); } catch (e) {}
      });
      attach(currentId());

      // Lightweight poll so React mount/unmount timing of the indicator
      // never desyncs the badge (counter appears/disappears with the indicator).
      pollTimer = window.setInterval(scheduleSync, 400);

      ctx.effect(() => () => {
        if (pollTimer !== null) window.clearInterval(pollTimer);
        if (stopList) { try { stopList(); } catch (e) {} }
        if (stopEvent) { try { stopEvent(); } catch (e) {} }
        if (raf) {
          if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
          else clearTimeout(raf);
        }
        if (counterSpan && counterSpan.parentNode) counterSpan.remove();
      }, "dsh-token-counter: cleanup");
    }

    const inject = ["sessions"];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
