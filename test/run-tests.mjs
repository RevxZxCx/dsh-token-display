// Test harness for the dsh-token-counter client half (feature-set rewrite).
// Runs the real lib/client.js factory in a mocked browser + sessions/configForms
// service, feeds synthetic assistant/live-chunk deltas, and asserts:
//   - factory registration + inject list
//   - live merged-mode output counter (CJK/latin estimation)
//   - split-mode "in ... · out ..." display
//   - authoritative settle via assistant/message usage
//   - per-operation "use N token" totals (input+output) keyed by turn
//   - settings card controller construction
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
  const el = {
    tagName: tag.toUpperCase(),
    id: "",
    _text: "",
    children: [],
    parentNode: null,
    attributes: {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get className() { return this.attributes["class"] ?? ""; },
    set className(v) { this.attributes["class"] = String(v); },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    remove() {
      if (this.parentNode) {
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      }
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (el) => {
        for (const c of el.children) {
          if (matchSel(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    closest(sel) {
      let p = this;
      while (p) {
        if (matchSel(p, sel)) return p;
        p = p.parentNode;
      }
      return null;
    }
  };
  return el;
}

function matchSel(el, sel) {
  // handle compound "tag[attr]" / "tag[attr=val]"
  let m = sel.match(/^(\w+)\[([^\]]+)\]$/);
  if (m) {
    if (el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
    return matchAttr(el, "[" + m[2] + "]");
  }
  if (sel.startsWith(".")) {
    const cls = (el.getAttribute("class") || "").split(/\s+/);
    return cls.includes(sel.slice(1));
  }
  if (sel.startsWith("[") && sel.endsWith("]")) {
    return matchAttr(el, sel);
  }
  return el.tagName.toLowerCase() === sel.toLowerCase();
}

function matchAttr(el, sel) {
  const inner = sel.slice(1, -1);
  const m = inner.match(/^([\w-]+)=["']?(.*?)["']?$/);
  if (m) return el.getAttribute(m[1]) === m[2];
  const m2 = inner.match(/^([\w-]+)$/);
  if (m2) return el.getAttribute(m2[1]) !== null;
  return false;
}

// The running indicator: div[data-chat-running] > span.xz4KEq_runningContent
const runningContent = makeElement("span");
runningContent.setAttribute("class", "xz4KEq_runningContent");
const running = makeElement("div");
running.setAttribute("data-chat-running", "true");
running.appendChild(runningContent);

// A closed process group: div[data-chat-turn=1] > button[data-process-activity]
const processBtn = makeElement("button");
processBtn.setAttribute("data-process-activity", "thinking");
const processGroup = makeElement("div");
processGroup.setAttribute("data-chat-turn", "1");
processGroup.appendChild(processBtn);

const styleStore = new Map();
const document = {
  getElementById(id) { return styleStore.get(id) ?? null; },
  createElement(tag) { const e = makeElement(tag); return e; },
  querySelector(sel) {
    if (sel === "[data-chat-running]") return running;
    return null;
  },
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (matchSel(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(running); walk(processGroup);
    // "button[data-process-activity]" matches processBtn via descendant walk
    return out;
  },
  head: { appendChild(el) { /* style element; track by id */ if (el.id) styleStore.set(el.id, el); } }
};

// ── window globals ──────────────────────────────────────────────────
let rafQueue = [];
let intervalCb = null;
const window = {
  setInterval: (cb) => { intervalCb = cb; return 1; },
  clearInterval: () => { intervalCb = null; }
};
const sandboxSetTimeout = (fn) => { rafQueue.push(fn); return rafQueue.length; };
const sandboxClearTimeout = () => {};

// ── react + primitives mocks ────────────────────────────────────────
const jsx = (type, props, ...rest) => ({ type, props, children: rest });
const jsxs = (type, props) => ({ type, props, children: props && props.children });

function mockSettingsFormModel() {
  return class SettingsFormModel {
    constructor(scope, specs) { this.scope = scope; this.specs = specs; this._listeners = []; }
    bind(project) {
      const store = {
        getSnapshot: () => project(),
        subscribe: (fn) => { this._listeners.push(fn); return () => {}; }
      };
      return store;
    }
    shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }; }
    field(f) {
      const spec = this.specs.find((s) => s.field === f);
      const v = this.scope.getSnapshot().value?.[f];
      return { text: spec ? spec.format(v) : String(v), overridden: false, invalid: false };
    }
    actions() { return { edit: () => {}, resetField: () => {}, save: async () => {}, discard: () => {} }; }
    dispose() {}
  };
}

const primitivesMock = {
  SettingsForm: () => null,
  SettingsFormModel: mockSettingsFormModel(),
  SegmentedControl: () => null,
  Switch: () => null,
  TextShimmer: () => null,
  Checkbox: () => null
};

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

const factoryRequire = (name) => {
  if (name === "react/jsx-runtime") return { jsx, jsxs, Fragment: Symbol("Fragment") };
  if (name === "react") return { createElement: () => null, memo: (x) => x, useState: () => [null, () => {}], useCallback: (fn) => fn, useRef: () => ({ current: null }), useEffect: () => {} };
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitivesMock;
  throw new Error("unexpected require: " + name);
};
const mod = registration.factory(factoryRequire);
assert(typeof mod.apply === "function", "exports.apply is a function");
assert(Array.isArray(mod.inject) && mod.inject.includes("sessions"), "exports.inject includes sessions");
assert(mod.inject.includes("slots") && mod.inject.includes("configForms") && mod.inject.includes("locale"),
  "exports.inject includes slots/configForms/locale");

// ── mock sessions service ───────────────────────────────────────────
function makeBinding() {
  let listener = null;
  let snapshot = { entries: [], change: { kind: "replace", entries: [] } };
  const eventSource = {
    subscribe(fn) { listener = fn; return () => { listener = null; }; },
    getSnapshot() { return snapshot; },
    _emit(kind, entries) {
      snapshot = { entries, change: { kind, entries } };
      if (listener) listener();
    }
  };
  return { eventSource };
}

let listListener = null;
const byId = { s1: { id: "s1", retainedBy: { mainView: 1 } } };
const list = {
  getSnapshot() { return { ids: Object.keys(byId), byId }; },
  subscribe(fn) { listListener = fn; return () => { listListener = null; }; }
};
const binding = makeBinding();
const sessions = {
  list,
  binding: (id) => (id === "s1" ? binding : undefined)
};

// ── mock configForms service ────────────────────────────────────────
let cfgValue = { displayMode: "merged", showInput: true, showOutput: true, showPerOp: true };
let cfgListener = null;
const cfgScope = {
  getSnapshot() { return { status: "ready", writable: true, value: cfgValue, base: {}, user: {}, revision: 1 }; },
  subscribe(fn) { cfgListener = fn; return () => { cfgListener = null; }; },
  mutate: async () => true
};
const configForms = {
  get: () => cfgScope,
  whileServed: (_ns, cb) => cb(new Set(_ns)),
  developerTools: { enabled: { getSnapshot: () => false } }
};

// ── mock slots + locale ─────────────────────────────────────────────
const slotRegistrations = [];
const slots = {
  inject: (_slotName, registerFn) => { slotRegistrations.push(registerFn()); },
  register: (desc, comp) => ({ ...desc, component: comp })
};
const locale = {
  bind: () => (k) => k,
  register: () => {}
};

const effects = [];
const ctx = {
  get(name) {
    if (name === "sessions") return sessions;
    if (name === "configForms") return configForms;
    if (name === "slots") return slots;
    if (name === "locale") return locale;
    return undefined;
  },
  effect(fn) { const cleanup = fn(); effects.push(cleanup); }
};

// ── run apply ───────────────────────────────────────────────────────
mod.apply(ctx);
assert(effects.length >= 2, "apply registered ctx.effect cleanups");

function flushRaf() {
  while (rafQueue.length) {
    const q = rafQueue;
    rafQueue = [];
    for (const fn of q) fn();
  }
}
function runPoll() {
  if (intervalCb) intervalCb();
  flushRaf();
}

function counterText() {
  const span = runningContent.children.find((c) => c.getAttribute("data-dsh-token-counter") === "true");
  if (!span) return null;
  return span.children[0] ? span.children[0].textContent : null;
}
function useTokenText() {
  const span = processBtn.children.find((c) => c.getAttribute("data-dsh-use-token") === "true");
  return span ? span.textContent : null;
}

// ── feed synthetic deltas ───────────────────────────────────────────
const chunk = (type, text) => ({ type, text });

// 1) merged mode: live output counter
binding.eventSource._emit("replace", [{ type: "transient", event: { type: "assistant/live-chunk", data: { chunk: chunk("text-delta", "你好") } } }]);
flushRaf();
assert(counterText() === "out 2 token", "merged: 2 CJK -> 'out 2 token' (got '" + counterText() + "')");

binding.eventSource._emit("append", [{ type: "transient", event: { type: "assistant/live-chunk", data: { chunk: chunk("text-delta", "hello world") } } }]);
flushRaf();
assert(counterText() === "out 5 token", "merged: +latin -> 'out 5 token' (got '" + counterText() + "')");

// 2) authoritative settle via assistant/message
binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/message", data: { turn: 1, step: 0, usage: { inputTokens: 100, outputTokens: 42 } } } }]);
flushRaf();
assert(counterText() === "out 42 token", "settle snaps to authoritative output -> 'out 42 token' (got '" + counterText() + "')");
runPoll();
assert(useTokenText() === "use 142 token", "per-op total = input+output -> 'use 142 token' (got '" + useTokenText() + "')");

// 3) split mode
cfgValue = { displayMode: "split", showInput: true, showOutput: true, showPerOp: true };
if (cfgListener) cfgListener();
flushRaf();
assert(counterText() === "in 100 token · out 42 token", "split: 'in 100 token · out 42 token' (got '" + counterText() + "')");

// 4) showOutput off (split) -> input only
cfgValue = { displayMode: "split", showInput: true, showOutput: false, showPerOp: true };
if (cfgListener) cfgListener();
flushRaf();
assert(counterText() === "in 100 token", "split + showOutput off -> 'in 100 token' (got '" + counterText() + "')");

// 5) step/start resets (back to merged)
cfgValue = { displayMode: "merged", showInput: true, showOutput: true, showPerOp: true };
if (cfgListener) cfgListener();
binding.eventSource._emit("append", [{ type: "event", event: { type: "step/start" } }]);
flushRaf();
assert(counterText() === "out 0 token", "step/start resets -> 'out 0 token' (got '" + counterText() + "')");

// 6) settings surfaces registered (bundle config page + settings tab + item card)
const bySlot = (n) => slotRegistrations.find((r) => r && r.name === n);
const bundle = bySlot("plugins.bundle.config");
assert(bundle && bundle.key === "dsh-token-counter", "bundle config seat keyed by the package name");
const tab = bySlot("settings.plugins.tab");
assert(tab && tab.id === "dsh-token-counter", "Plugins settings section tab registered");
assert(tab && tab.order > 0 && typeof tab.label === "function", "settings tab has order + label");
assert(tab && tab.locale === "settings.tokenCounter", "settings tab carries the locale namespace");
const tabProps = tab && tab.inject();
assert(tabProps && tabProps.section === true, "settings tab injects section:true");
assert(tabProps && tabProps.hooks && tabProps.hooks.tokenCounterCard, "settings tab injects the form store");
const section = bySlot("settings.section");
assert(section && section.id === "dsh-token-counter", "Settings navigation entry registered");
assert(section && section.order > 0 && typeof section.label === "function", "settings section has order + label");
const item = bySlot("plugins.item");
assert(item && item.id === "dsh-token-counter", "Plugins-page item card registered");
assert(slotRegistrations.every((r) => r === undefined || typeof r.component === "function"), "every seat renders the card component");

// ── cleanup ─────────────────────────────────────────────────────────
for (const clean of effects) { try { clean(); } catch (e) {} }
const spanAfterCleanup = runningContent.children.find((c) => c.getAttribute("data-dsh-token-counter") === "true");
assert(spanAfterCleanup === undefined, "cleanup removes the counter span");

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
