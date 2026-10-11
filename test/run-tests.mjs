// Test harness for the dsh-token-counter client half.
// Runs the real lib/client.js factory in a mocked browser + sessions service,
// feeds synthetic assistant/live-chunk deltas, and asserts the counter.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(join(__dirname, "..", "lib", "client.js"), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("  ✓ " + msg);
  } else {
    failures++;
    console.error("  ✗ FAIL: " + msg);
  }
}

// ── minimal DOM ─────────────────────────────────────────────────────
function makeElement(tag) {
  return {
    tagName: tag.toUpperCase(),
    id: "",
    textContent: "",
    children: [],
    parentNode: null,
    _style: {},
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    querySelector(sel) {
      const isClass = sel.startsWith(".");
      const isAttr = sel.startsWith("[") && sel.endsWith("]");
      const walk = (el) => {
        for (const c of el.children) {
          if (isClass) {
            const cls = (c.getAttribute("class") || "").split(/\s+/);
            if (cls.includes(sel.slice(1))) return c;
          } else if (isAttr) {
            const inner = sel.slice(1, -1);
            const m = inner.match(/^([\w-]+)=["']?(.*?)["']?$/);
            if (m && c.getAttribute(m[1]) === m[2]) return c;
          }
          const found = walk(c);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    },
    remove() {
      if (this.parentNode) {
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      }
    }
  };
}

// The running indicator: div[data-chat-running] > span.xz4KEq_runningContent
const runningContent = makeElement("span");
runningContent.setAttribute("class", "xz4KEq_runningContent");
const running = makeElement("div");
running.setAttribute("data-chat-running", "true");
running.appendChild(runningContent);

const styleStore = new Map(); // id -> element
const head = makeElement("head");

const document = {
  getElementById(id) { return styleStore.get(id) ?? null; },
  createElement(tag) { return makeElement(tag); },
  querySelector(sel) {
    if (sel === "[data-chat-running]") return running;
    return null;
  },
  head: { appendChild(el) { head.appendChild(el); } }
};

// ── window globals ──────────────────────────────────────────────────
let rafQueue = [];
const window = {
  setInterval: () => 1,
  clearInterval: () => {}
};
// The plugin uses BARE setTimeout/clearTimeout (globals), so inject them too.
const sandboxSetTimeout = (fn) => { rafQueue.push(fn); return rafQueue.length; };
const sandboxClearTimeout = () => {};

// ── load the factory ────────────────────────────────────────────────
let registration = null;
window.__ModuleLoader__ = { load: (r) => { registration = r; } };

const sandbox = { window, document };
const vmRun = (src) => {
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "window", "document", "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout",
    src
  );
  fn(sandbox.window, sandbox.document, undefined, undefined, sandboxSetTimeout, sandboxClearTimeout);
};
vmRun(clientSrc);

assert(registration && registration.id === "dsh-token-counter", "factory registered with id dsh-token-counter");

const factoryRequire = () => {
  throw new Error("require not expected in test");
};
const mod = registration.factory(factoryRequire);
assert(typeof mod.apply === "function", "exports.apply is a function");
assert(Array.isArray(mod.inject) && mod.inject.includes("sessions"), "exports.inject includes sessions");

// ── mock sessions service ───────────────────────────────────────────
function makeBinding() {
  let listener = null;
  let snapshot = { entries: [], change: { kind: "replace", entries: [] } };
  const eventSource = {
    subscribe(fn) { listener = fn; return () => { listener = null; }; },
    getSnapshot() { return snapshot; },
    // test helpers
    _emit(kind, entries) {
      snapshot = { entries, change: { kind, entries } };
      if (listener) listener();
    }
  };
  return { eventSource };
}

let listListener = null;
const byId = {
  s1: { id: "s1", retainedBy: { mainView: 1 } }
};
const list = {
  getSnapshot() { return { ids: Object.keys(byId), byId }; },
  subscribe(fn) { listListener = fn; return () => { listListener = null; }; }
};
const binding = makeBinding();
const sessions = {
  list,
  binding: (id) => (id === "s1" ? binding : undefined)
};

let effectCleanup = null;
const ctx = {
  get(name) { return name === "sessions" ? sessions : undefined; },
  effect(fn) { effectCleanup = fn(); }
};

// ── run apply ───────────────────────────────────────────────────────
mod.apply(ctx);
assert(effectCleanup !== null, "apply registered a ctx.effect cleanup");

function flushRaf() {
  while (rafQueue.length) {
    const q = rafQueue;
    rafQueue = [];
    for (const fn of q) fn();
  }
}

function counterText() {
  const span = runningContent.children.find((c) => c.getAttribute("data-dsh-token-counter") === "true");
  return span ? span.textContent : null;
}

// ── feed synthetic deltas ───────────────────────────────────────────
const chunk = (type, text) => ({ type, text });

binding.eventSource._emit("replace", [{ type: "transient", event: { type: "assistant/live-chunk", data: { chunk: chunk("text-delta", "你好") } } }]);
flushRaf();
assert(runningContent.children.some((c) => c.getAttribute("data-dsh-token-counter") === "true"),
  "counter span injected into runningContent (lazily, on first sync)");
assert(counterText() === "2 token", "2 CJK chars -> '2 token' (got '" + counterText() + "')");

binding.eventSource._emit("append", [{ type: "transient", event: { type: "assistant/live-chunk", data: { chunk: chunk("text-delta", "hello world") } } }]);
flushRaf();
// "hello world" = 10 latin chars + 1 space(skipped) => round(10/4)=3; total 2+3=5
assert(counterText() === "5 token", "CJK + latin accumulate -> '5 token' (got '" + counterText() + "')");

binding.eventSource._emit("append", [{ type: "transient", event: { type: "assistant/live-chunk", data: { chunk: chunk("reasoning-delta", "思考过程") } } }]);
flushRaf();
// +4 CJK => 2+4=6 CJK, 10 latin => 6 + round(10/4)=6+3=9
assert(counterText() === "9 token", "reasoning-delta accumulates -> '9 token' (got '" + counterText() + "')");

// step/start resets
binding.eventSource._emit("append", [{ type: "event", event: { type: "step/start" } }]);
flushRaf();
assert(counterText() === "0 token", "step/start resets -> '0 token' (got '" + counterText() + "')");

// ── cleanup ─────────────────────────────────────────────────────────
effectCleanup();
const spanAfterCleanup = runningContent.children.find((c) => c.getAttribute("data-dsh-token-counter") === "true");
assert(spanAfterCleanup === undefined, "cleanup removes the counter span");

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
