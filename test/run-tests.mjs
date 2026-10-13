// Test harness for the dsh-where-did-my-tokens-go client half (feature-set rewrite).
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
    dataset: {},
    style: { removeProperty(name) { delete this[name]; } },
    get textContent() {
      // mirror the DOM: an element's text is its subtree concatenated
      if (this.children.length) return this.children.map((c) => c.textContent).join("");
      return this._text;
    },
    set textContent(v) {
      this._text = String(v);
      this.children.length = 0;   // assigning text empties children, like the DOM
    },
    get className() { return this.attributes["class"] ?? ""; },
    set className(v) { this.attributes["class"] = String(v); },
    get firstChild() { return this.children[0] ?? null; },
    get firstElementChild() { return this.children[0] ?? null; },
    get lastElementChild() { return this.children[this.children.length - 1] ?? null; },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) { this.children.splice(i, 1); child.parentNode = null; }
      return child;
    },
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

// A second reply with TWO completed operations and one still streaming, so the
// per-operation attribution can be proven: the two rows must differ.
const turn2 = makeElement("div");
turn2.setAttribute("data-chat-turn", "2");
const rowA = makeElement("button");
rowA.setAttribute("data-process-activity", "thinking");
const rowB = makeElement("button");
rowB.setAttribute("data-process-activity", "tools");
const rowLive = makeElement("button");
rowLive.setAttribute("data-process-activity", "tools");
const liveShimmer = makeElement("span");
liveShimmer.setAttribute("data-shimmer", "true");
rowLive.appendChild(liveShimmer);
turn2.appendChild(rowA);
turn2.appendChild(rowB);
turn2.appendChild(rowLive);

// Extra roots a test can attach later (simulating new transcript rows appearing).
const documentWalkTargets = [];

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
    walk(running); walk(processGroup); walk(turn2);
    for (const extra of documentWalkTargets) walk(extra);
    // "button[data-process-activity]" matches processBtn via descendant walk
    return out;
  },
  head: { appendChild(el) { /* style element; track by id */ if (el.id) styleStore.set(el.id, el); } }
};

// ── window globals ──────────────────────────────────────────────────
let rafQueue = [];
let intervalCb = null;
// Interval registry the hook runner drives by id, so several timers can be
// live at once and each can be ticked or cleared explicitly.
let intervalSeq = 0;
const intervals = new Map();
const window = {
  setInterval: (cb) => { intervalCb = cb; intervals.set(++intervalSeq, cb); return intervalSeq; },
  clearInterval: (id) => { intervals.delete(id); if (id === 1) intervalCb = null; }
};
const sandboxSetTimeout = (fn) => { rafQueue.push(fn); return rafQueue.length; };
const sandboxClearTimeout = () => {};

// ── react + primitives mocks ────────────────────────────────────────
// Faithful to the real react/jsx-runtime signature: jsx(type, config, maybeKey).
// Children ONLY arrive through config.children; a third positional argument is
// a React key. Call sites that pass children positionally render EMPTY elements
// in the real app, so the mock models the key argument instead of swallowing
// extra arguments into a children list.
const jsx = (type, props, key) => (key === undefined ? { type, props } : { type, props, key });
const jsxs = jsx;
// Minimal hook fakes: enough to MOUNT ModePreviewCard and drive its hover
// animation. Effect semantics mirror React: the create function runs (and the
// previous cleanup first) only when the deps array changes; slots persist
// across renders. Intervals are id-addressable through the window mock, so a
// test can tick the card's own timer without disturbing the live engine's.
function depsChanged(prev, next) {
  if (prev === undefined || next === undefined) return true;
  if (prev.length !== next.length) return true;
  return next.some((value, i) => !Object.is(value, prev[i]));
}
function makeHookRunner() {
  const slots = [];
  const effects = [];
  let cursor = 0;
  return {
    render(fn, props) {
      cursor = 0;
      const result = fn(props);
      for (const slot of effects) {
        if (slot !== undefined && slot.pending) {
          slot.pending = false;
          if (slot.cleanup) slot.cleanup();
          slot.cleanup = slot.create() || null;
        }
      }
      return result;
    },
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      const set = (v) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; };
      return [slots[i], set];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useEffect(create, deps) {
      const i = cursor++;
      const slot = effects[i];
      if (slot === undefined) effects[i] = { deps, create, pending: true, cleanup: null };
      else if (depsChanged(slot.deps, deps)) { slot.deps = deps; slot.create = create; slot.pending = true; }
      else slot.deps = deps;
    },
    unmount() {
      for (const slot of effects) if (slot !== undefined && slot.cleanup) slot.cleanup();
      effects.length = 0;
      slots.length = 0;
    },
  };
}

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
    actions() { return { edit: (f, v) => { edits.push([f, v]); }, resetField: () => {}, save: async () => {}, discard: () => {} }; }
    dispose() {}
  };
}
const edits = [];

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

assert(registration && registration.id === "dsh-where-did-my-tokens-go", "factory registered with id dsh-where-did-my-tokens-go");

const factoryRequire = (name) => {
  if (name === "react/jsx-runtime") return { jsx, jsxs, Fragment: Symbol("Fragment") };
  if (name === "react") return {
    createElement: () => null, memo: (x) => x, useCallback: (fn) => fn,
    // hook calls delegate to the active runner so component tests can mount
    // real state + effects; default no-ops keep apply()-level tests unaffected.
    useState: (i) => (activeHooks ? activeHooks.useState(i) : [i, () => {}]),
    useRef: (i) => (activeHooks ? activeHooks.useRef(i) : { current: i }),
    useEffect: (fn, deps) => { if (activeHooks) activeHooks.useEffect(fn, deps); },
  };
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitivesMock;
  throw new Error("unexpected require: " + name);
};
let activeHooks = null;
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
// `projectionValues.contextPressure` mirrors what the harness's token-meter
// ships to the browser: the priced size of the prompt about to be sent.
let projectedTokens = 5000;
const byId = {
  s1: {
    id: "s1",
    retainedBy: { mainView: 1 },
    projectionValues: { contextPressure: { projectedTokens: 5000, contextWindow: 200000 } },
  },
};
const list = {
  getSnapshot() {
    byId.s1.projectionValues = { contextPressure: { projectedTokens, contextWindow: 200000 } };
    return { ids: Object.keys(byId), byId };
  },
  subscribe(fn) { listListener = fn; return () => { listListener = null; }; }
};
const binding = makeBinding();
const sessions = {
  list,
  binding: (id) => (id === "s1" ? binding : undefined)
};

// ── mock configForms service ────────────────────────────────────────
let cfgValue = {
  displayMode: "merged", showInput: true, showOutput: true, showPerOp: true,
  inputUnit: "auto", outputUnit: "auto", perOpUnit: "auto",
  inputFont: 0, outputFont: 0, perOpFont: 0,
  inputColor: "", outputColor: "", perOpColor: "",
};
// cfgValue writes in tests keep working without restating the nine style
// fields: mutate through this helper for the four booleans/mode only.
const setCfg = (patch) => { cfgValue = { ...cfgValue, ...patch }; };
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
// The live engine's 400ms poll registered with id 1; freeze it now so preview
// timers registered later can never shadow it in runPoll().
const livePollCb = intervalCb;
assert(effects.length >= 2, "apply registered ctx.effect cleanups");

function flushRaf() {
  while (rafQueue.length) {
    const q = rafQueue;
    rafQueue = [];
    for (const fn of q) fn();
  }
}
function runPoll() {
  if (livePollCb) livePollCb();
  flushRaf();
}

function counterText() {
  const span = runningContent.children.find((c) => c.getAttribute("data-dsh-where-did-my-tokens-go") === "true");
  if (!span) return null;
  return span.children[0] ? span.children[0].textContent : null;
}
function counterSpan() {
  return runningContent.children.find((c) => c.getAttribute("data-dsh-where-did-my-tokens-go") === "true") || null;
}
function useTokenText() {
  const span = processBtn.children.find((c) => c.getAttribute("data-dsh-use-token") === "true");
  return span ? span.textContent : null;
}
function useTokenOf(btn) {
  const span = btn.children.find((c) => c.getAttribute("data-dsh-use-token") === "true");
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
setCfg({ displayMode: "split", showInput: true, showOutput: true, showPerOp: true });
if (cfgListener) cfgListener();
flushRaf();
assert(counterText() === "in 100 token · out 42 token", "split: 'in 100 token · out 42 token' (got '" + counterText() + "')");

// 4) showOutput off (split) -> input only
setCfg({ displayMode: "split", showInput: true, showOutput: false, showPerOp: true });
if (cfgListener) cfgListener();
flushRaf();
assert(counterText() === "in 100 token", "split + showOutput off -> 'in 100 token' (got '" + counterText() + "')");

// 5) step/start resets: merged shows the input count again
setCfg({ displayMode: "merged", showInput: true, showOutput: true, showPerOp: true });
if (cfgListener) cfgListener();
binding.eventSource._emit("append", [{ type: "event", event: { type: "step/start" } }]);
flushRaf();
assert(counterText() === "in 5K token", "merged after step/start -> priced prompt, 'in 5K token' (got '" + counterText() + "')");

// 5a) prefill phase: with no recognised events yet, the badge still prices input
{
  binding.eventSource._emit("replace", []);
  projectedTokens = 6100;
  flushRaf();
  assert(counterText() === "in 6.1K token", "merged prefill without events -> 'in 6.1K token' (got '" + counterText() + "')");
  // authoritative settle value outranks the priced projection
  binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/message", data: { turn: 9, step: 0, usage: { inputTokens: 777, outputTokens: 5 } } } }]);
  flushRaf();
  assert(counterText() === "out 5 token", "merged output phase shows out (got '" + counterText() + "')");
  // a new step re-prices from the projection (the old settle value is not the new prompt)
  binding.eventSource._emit("append", [{ type: "event", event: { type: "step/start" } }]);
  flushRaf();
  assert(counterText() === "in 6.1K token", "merged after step/start re-reads the projection (got '" + counterText() + "')");
}

// 5b) merged + showInput off: prefill shows the output counter, never a blank row
setCfg({ displayMode: "merged", showInput: false, showOutput: true, showPerOp: true });
if (cfgListener) cfgListener();
binding.eventSource._emit("append", [{ type: "event", event: { type: "step/start" } }]);
flushRaf();
assert(counterText() === "out 0 token", "merged + showInput off during prefill -> falls back to out (got '" + counterText() + "')");

// 5c) split mode keeps both counts visible through the whole turn
setCfg({ displayMode: "split", showInput: true, showOutput: true, showPerOp: true });
if (cfgListener) cfgListener();
binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/live-chunk", data: { chunk: chunk("text-delta", "abcd") } } }]);
flushRaf();
assert(counterText() === "in 6.1K token · out 1 token", "split during output keeps in + out (got '" + counterText() + "')");

// 5c-2) a deployment that ships no projection falls back to the last input learned
{
  setCfg({ displayMode: "merged", showInput: true, showOutput: true, showPerOp: true });
  if (cfgListener) cfgListener();
  binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/message", data: { turn: 12, step: 0, usage: { inputTokens: 4321, outputTokens: 9 } } } }]);
  flushRaf();
  projectedTokens = undefined;              // contextPressure absent entirely
  binding.eventSource._emit("append", [{ type: "event", event: { type: "step/start" } }]);
  flushRaf();
  assert(counterText() === "in 4.3K token", "no projection -> prefill falls back to last known input (got '" + counterText() + "')");
  projectedTokens = 6100;                   // restore for later checks
}

// 5d) badge mirrors the platform TextShimmer geometry: static content layer plus
// one decorative overlay whose inner text layer carries the same string, so the
// highlight crosses FIXED glyphs (never a second copy of the text sliding by).
{
  const span = counterSpan();
  assert(span !== null, "badge exists for structure checks");
  const content = span.children[0];
  const dec = span.children[1];
  assert(content.className === "dsh-where-did-my-tokens-go-content", "first layer is the static content");
  assert(dec.getAttribute("aria-hidden") === "true" && dec.getAttribute("inert") === "", "overlay is aria-hidden and inert");
  const sweep = dec.children[0];
  assert(sweep.className === "dsh-where-did-my-tokens-go-sweep", "overlay wraps the travelling mask");
  const highlight = sweep.children[0];
  assert(highlight.className === "dsh-where-did-my-tokens-go-content dsh-where-did-my-tokens-go-highlight", "mask wraps the counter-travelling highlight");
  assert(highlight.textContent === content.textContent, "highlight duplicates the content text (masked tint, not a moving copy)");

  // A text change must land in BOTH layers, or the tint desyncs from the glyphs.
  setCfg({ displayMode: "split", showInput: true, showOutput: true, showPerOp: true });
  if (cfgListener) cfgListener();
  projectedTokens = 6200;
  runPoll();
  const span2 = counterSpan();
  assert(span2 === span, "badge node is reused across updates (no flicker)");
  assert(/in 6.2K token/.test(span2.children[0].textContent),
    "content layer updated (got '" + span2.children[0].textContent + "')");
  const hl2 = span2.children[1].children[0].children[0];
  assert(hl2.textContent === span2.children[0].textContent,
    "highlight layer updated in lockstep (got '" + hl2.textContent + "')");
  assert(styleStore.get("dsh-where-did-my-tokens-go-style").textContent.includes("dsh-where-did-my-tokens-go-highlight"), "counter-moving keyframes shipped");
  assert(styleStore.get("dsh-where-did-my-tokens-go-style").textContent.includes("--dsw-alias-label-shimmer"), "highlight color inherits the row's shimmer variable");
  assert(styleStore.get("dsh-where-did-my-tokens-go-style").textContent.includes("font:inherit"), "badge inherits the running row's font");
  {
    const css = styleStore.get("dsh-where-did-my-tokens-go-style").textContent;
    assert(css.includes(".dtc-headTitle{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}"),
      "preview head follows the theme (readable on dark hosts)");
    assert(css.includes(".dtc-switches .dtc-headTitle{color:#1f2328;}"),
      "switches heading keeps fixed dark ink on its light panel (no theme bleed-through)");
    assert(css.includes(".dtc-cardStatic:not(.dtc-cardOn):hover{"),
      "read-only hover reset spares the selected card (blue highlight survives hover)");
    assert(!css.includes(".dtc-cardStatic:hover{"),
      "no unscoped static-hover reset left to erase dtc-cardOn");
    // The specificity trap the second review caught: the GENERIC hover lift
    // also out-ranked .dtc-cardOn (0,1,0), so it must be scoped away from the
    // selected card too — a string check on the new selector alone was blind.
    assert(css.includes(".dtc-card:not(.dtc-cardOn):hover{"),
      "hover lift is scoped to unselected cards (selected keeps its ring on hover)");
    assert(!/\.dtc-card:hover\{/.test(css),
      "no unscoped .dtc-card:hover rule that could erase the selection ring");
    // The ring must beat the baseline border by specificity, not source order:
    // compound .dtc-card.dtc-cardOn (0,2,0) > .dtc-card (0,1,0) either way.
    assert(css.includes(".dtc-card.dtc-cardOn{"),
      "selection ring is specificity-secured (survives rule reordering)");
    assert(!/[^.\w-]\.dtc-cardOn\{/.test(css),
      "no bare .dtc-cardOn rule that would depend on source order");
  }
}

// 5f) per-OPERATION attribution: two completed operations in ONE reply must show
// their OWN steps' usage, never the same whole-reply total (the old bug).
{
  setCfg({ displayMode: "merged", showInput: true, showOutput: true, showPerOp: true });
  if (cfgListener) cfgListener();

  // Step 0 of turn 2 settles while rowA is the open row.
  binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/message", data: { turn: 2, step: 0, usage: { inputTokens: 1000, outputTokens: 20 } } } }]);
  runPoll();
  assert(useTokenOf(rowA) === "use 1K token", "rowA shows its own step (1020 -> 1K auto) (got '" + useTokenOf(rowA) + "')");
  assert(useTokenOf(rowB) === null, "rowB has no number before its step settles (got '" + useTokenOf(rowB) + "')");
  assert(useTokenOf(rowLive) === null, "the streaming row shows nothing");

  // Step 1 settles; rowB is now closed and takes the NEXT step, not the running total.
  binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/message", data: { turn: 2, step: 1, usage: { inputTokens: 1200, outputTokens: 30 } } } }]);
  runPoll();
  assert(useTokenOf(rowB) === "use 1.2K token", "rowB shows its own step (1230 -> 1.2K auto), not the reply total (got '" + useTokenOf(rowB) + "')");
  assert(useTokenOf(rowA) === "use 1K token", "rowA keeps its own figure after a later step lands");
  assert(useTokenOf(rowA) !== useTokenOf(rowB), "the two operations show DIFFERENT numbers");

  // A re-settled step replaces its figure rather than accumulating.
  binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/message", data: { turn: 2, step: 1, usage: { inputTokens: 1200, outputTokens: 50 } } } }]);
  runPoll();
  assert(useTokenOf(rowB) === "use 1.3K token", "re-settled step re-prices, never double counts (got '" + useTokenOf(rowB) + "')");

  // totalTokens wins when the provider reports it, and a row only earns its
  // number once it closes.
  binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/message", data: { turn: 2, step: 2, usage: { inputTokens: 900, outputTokens: 5, totalTokens: 905 } } } }]);
  runPoll();
  assert(useTokenOf(rowLive) === null, "still-streaming row stays unnumbered even after its step settles");
  liveShimmer.remove();
  runPoll();
  assert(useTokenOf(rowLive) === "use 905 token", "closing the row paints its own step, preferring totalTokens (905 stays raw) (got '" + useTokenOf(rowLive) + "')");
}

// 5g) reload: a `replace` snapshot replays the whole loaded history at once, so
// every row must be numbered from ITS OWN step even though nothing settled live.
{
  const turn5 = makeElement("div");
  turn5.setAttribute("data-chat-turn", "5");
  const r5a = makeElement("button");
  r5a.setAttribute("data-process-activity", "thinking");
  const r5b = makeElement("button");
  r5b.setAttribute("data-process-activity", "tools");
  turn5.appendChild(r5a);
  turn5.appendChild(r5b);

  const message = (turn, step, inputTokens, outputTokens) => ({
    type: "event",
    event: { type: "assistant/message", data: { turn, step, usage: { inputTokens, outputTokens } } },
  });

  // Attach the replayed history to the document, then emit one replace frame.
  documentWalkTargets.push(turn5);
  binding.eventSource._emit("replace", [
    message(5, 0, 2000, 40),
    message(5, 1, 2400, 60),
  ]);
  runPoll();
  assert(useTokenOf(r5a) === "use 2K token", "reload: first row numbers its own step (got '" + useTokenOf(r5a) + "')");
  assert(useTokenOf(r5b) === "use 2.5K token", "reload: second row numbers its own step (got '" + useTokenOf(r5b) + "')");
  assert(useTokenOf(r5a) !== useTokenOf(r5b), "reload: rows still differ (no shared total)");
}

// 6) settings surfaces registered (bundle config page + settings section + item card)
const bySlot = (n) => slotRegistrations.find((r) => r && r.name === n);
const bundle = bySlot("plugins.bundle.config");
assert(bundle && bundle.key === "dsh-where-did-my-tokens-go", "bundle config seat keyed by the package name");
// Regression: the duplicate page inside Settings → 内置插件 was removed. The
// settings.section entry is the plugin's only page in the Settings panel.
assert(bySlot("settings.plugins.tab") === undefined, "no duplicate settings.plugins.tab registration");
const section = bySlot("settings.section");
assert(section && section.id === "dsh-where-did-my-tokens-go", "Settings navigation entry registered");
assert(section && section.order > 0 && typeof section.label === "function", "settings section has order + label");
const sectionProps = section && section.inject();
assert(sectionProps && sectionProps.section === true, "settings section injects section:true");
assert(sectionProps && sectionProps.hooks && sectionProps.hooks.tokenCounterCard, "settings section injects the form store");
const item = bySlot("plugins.item");
assert(item && item.id === "dsh-where-did-my-tokens-go", "Plugins-page item card registered");
assert(slotRegistrations.every((r) => r === undefined || typeof r.component === "function"), "every seat renders the card component");

// ── 7) the card's render tree actually carries its children ──────────
// Regression: the settings panel rendered blank because jsx/jsxs received
// children as trailing arguments (React read them as a key and dropped them).
// The mock above now models that signature, so assert the element tree built
// by the component holds its children inside props.children.
function renderCard(registrationEntry, extraProps) {
  const face = registrationEntry.inject();
  const store = face.hooks.tokenCounterCard;
  const props = {
    ...face,
    t: (k) => k,
    useTokenCounterCard: (selector) => selector(store.getSnapshot()),
    ...extraProps,
  };
  return registrationEntry.component(props);
}
const childrenOf = (el) => (el && el.props && el.props.children);

for (const seatName of ["settings.section", "plugins.bundle.config", "plugins.item"]) {
  const entry = bySlot(seatName);
  if (!entry) continue;
  const tree = renderCard(entry, { view: "page" });
  assert(tree && tree.type !== "p", seatName + ": card renders an element tree");
  if (seatName === "settings.section") {
    const kids = childrenOf(tree);
    assert(Array.isArray(kids) && kids.length === 3, seatName + ": section wrapper has heading + intro + form children");
    assert(tree.key === undefined, seatName + ": section wrapper passes no bogus react key");
    if (!Array.isArray(kids)) continue;
    assert(kids[0] && kids[0].type === "h2", seatName + ": first child is the heading");
    assert(kids[1] && kids[1].type === "p", seatName + ": second child is the description");
    assert(kids[2] && kids[2].type === primitivesMock.SettingsForm, seatName + ": third child is the settings form");
  }
}

const sectionEntry = bySlot("settings.section");
const formEl = childrenOf(renderCard(sectionEntry, { view: "page" }))[2];
const layout = childrenOf(formEl);
assert(layout && layout.props.className === "dtc-layout", "settings form body is the dtc-layout");
const sections = childrenOf(layout);
assert(Array.isArray(sections) && sections.length === 2, "layout holds the preview section + the switches section");

// ── 7b) preview cards replace the segmented control ───────────────────
const previewsSection = sections[0];
assert(previewsSection.props.className === "dtc-previews", "first section is the preview area");
const headEl = childrenOf(previewsSection)[0];
assert(childrenOf(headEl).some((c) => c && c.props && c.props.children === "previewHint"),
  "preview head carries the hover hint copy");
const cardsEl = childrenOf(previewsSection)[1];
assert(cardsEl.props.className === "dtc-cards", "cards live in the dtc-cards grid");
const cards = childrenOf(cardsEl);
assert(Array.isArray(cards) && cards.length === 2, "exactly two preview cards");
assert(cards[0].props.mode === "merged" && cards[1].props.mode === "split", "cards preview merged + split");
assert(cards[0].key === "merged" && cards[1].key === "split", "each card carries a distinct react key (not a dropped positional child)");
assert(cards.some((c) => c.props.selected === true) && cards[0].props.selected === true,
  "the served mode's card is selected (merged)");
assert(cards.every((c) => c.props.showInput === true && c.props.showOutput === true && c.props.showPerOp === true),
  "cards mirror the current switch state");

// Clicking the other card edits displayMode through the form.
cards[1].props.onSelect("split");
assert(edits.some(([f, v]) => f === "displayMode" && v === "split"), "clicking the split card stages displayMode=split");

// Toggling a switch propagates into BOTH cards.
setCfg({ displayMode: "merged", showInput: false, showOutput: true, showPerOp: false });
if (cfgListener) cfgListener();
const layoutDiv2 = childrenOf(childrenOf(renderCard(sectionEntry, { view: "page" }))[2]);
const cards2 = childrenOf(childrenOf(childrenOf(layoutDiv2)[0])[1]);
assert(cards2.every((c) => c.props.showInput === false && c.props.showPerOp === false),
  "switch changes flow into the preview cards (in off, per-op off)");

// 7c) the switches section
setCfg({ displayMode: "merged", showInput: true, showOutput: true, showPerOp: true });
if (cfgListener) cfgListener();
const layout3 = childrenOf(childrenOf(renderCard(sectionEntry, { view: "page" }))[2]);
const switchesSection = childrenOf(layout3)[1];
assert(switchesSection.props.className === "dtc-switches", "second section is the switch panel");
const switchKids = childrenOf(switchesSection);
assert(switchKids[0].type === "h3", "switch panel has its own heading");
const switchRows = switchKids.slice(1);
assert(switchRows.length === 3 && switchRows.every((r) => r.props.className === "dtc-switchRow"),
  "three labelled switch rows");
const rowKids = childrenOf(switchRows[0]);
assert(rowKids[0].props.children === "showInput", "switch row keeps its visible caption");
// the caption's partner is now a control cluster: gear button + platform switch
const ctlKids = childrenOf(rowKids[1]);
assert(rowKids[1].props.className === "dtc-switchCtl", "caption pairs with the control cluster");
assert(ctlKids[0].type.name === "GearPanel" || (ctlKids[0].props && ctlKids[0].props["aria-label"] === "gearLabel"),
  "each switch row carries a gear button (aria-labelled)");
assert(ctlKids.some((c) => c.type === primitivesMock.Switch), "the platform switch stays in the row");
{
  // mount the first gear through the hook runner: closed by default, opens on
  // click, and exposes the three per-site fields (font / color / unit).
  const gearEl = ctlKids[0];
  const gearRunner = makeHookRunner();
  activeHooks = gearRunner;
  const drawGear = () => { gearRunner.render(gearEl.type, gearEl.props); return gearRunner.render(gearEl.type, gearEl.props); };
  let g = drawGear();
  const gearBtn = childrenOf(g)[0];
  assert(gearBtn.props["aria-expanded"] === "false", "gear panel starts collapsed");
  gearBtn.props.onClick();
  g = drawGear();
  assert(childrenOf(g).length === 2, "clicking the gear expands the dropdown panel");
  const panel = childrenOf(g)[1];
  assert(panel.props.className === "dtc-gearPanel", "expanded panel carries the gear-panel class");
  const fields = childrenOf(panel);
  assert(fields.length === 3, "panel exposes font + color + unit fields");
  const unitSelect = childrenOf(fields[2])[1];
  assert(unitSelect.type === "select" && unitSelect.props.value === "auto", "unit defaults to auto");
  const opts = unitSelect.props.children;
  assert(Array.isArray(opts) && opts.length === 5 && opts.map((o) => o.props.value).join(",") === "auto,K,M,G,T",
    "unit offers auto + K/M/G/T (5 choices)");
  const fontInput = childrenOf(fields[0])[1];
  assert(fontInput.props.type === "number" && fontInput.props.min === "0", "font field is a numeric input");
  const colorWrapKids = childrenOf(childrenOf(fields[1])[1]);
  assert(colorWrapKids[0].props.type === "color", "color field is a native color picker");

  // Choosing a unit stages the raw value through the form model (the panel is
  // still open from the click above; gearEl.props.edit IS the form's edit).
  const select2 = childrenOf(childrenOf(panel)[2])[1];
  select2.props.onChange({ target: { value: "M" } });
  assert(edits.some(([f, v]) => f === "inputUnit" && v === "M"), "unit choice stages inputUnit=M");

  // Old-host degradation (review 5c327ff6 P3): a host whose Config lacks the
  // fields yields text "undefined"; the select must clamp to "auto", not an
  // empty control.
  const junkState = {};
  for (const suf of ["Unit", "Font", "Color"]) junkState["input" + suf] = { text: "undefined" };
  const junkProps = { ...gearEl.props, state: junkState };
  const jr = makeHookRunner();
  activeHooks = jr;
  jr.render(gearEl.type, junkProps);
  const jbtn = childrenOf(jr.render(gearEl.type, junkProps))[0];
  jbtn.props.onClick();
  const jpanel = childrenOf(jr.render(gearEl.type, junkProps))[1];
  const jselect = childrenOf(childrenOf(jpanel)[2])[1];
  assert(jselect.props.value === "auto", "missing host fields still render auto-selected (no empty select)");
  const jcolorWrap = childrenOf(childrenOf(jpanel)[1])[1];
  assert(childrenOf(jcolorWrap)[0].props.value === "#1f2328", "junk color falls back to the picker sentinel");
  jr.unmount();
  gearRunner.unmount();
  activeHooks = null;
}

// ── 7d) preview state machine (pure logic behind the hover animation) ─
const P = mod.preview;
{
  // merged: in climbs to its cap, pauses, then out climbs to ITS cap, then done.
  let f = P.startFrame(true, true);
  const samples = [];   // [phaseBeforeTick, value] — the switch tick still counts as "in"
  let guard = 0;
  while (f && !f.done && guard++ < 500) {
    const before = f.phase;
    f = P.advance(f, "merged", true, true);
    samples.push([before, f.value]);
  }
  assert(f && f.done && guard < 500, "merged preview animation terminates");
  assert(samples[0][0] === "in" && samples[samples.length - 1][0] === "out", "merged runs in first, then swaps to out");
  const inPeak = Math.max(...samples.filter(([p]) => p === "in").map(([, v]) => v));
  const outPeak = Math.max(...samples.filter(([p]) => p === "out").map(([, v]) => v));
  assert(inPeak === P.FAKE_IN && outPeak === P.FAKE_OUT, "in/out each climb to their own cap then stop (in=" + inPeak + " out=" + outPeak + ")");
  assert(Math.max(...samples.map(([, v]) => v)) <= Math.max(P.FAKE_IN, P.FAKE_OUT), "numbers never exceed the cap");

  // merged with in only: climbs to FAKE_IN and stops (no swap to out).
  let f2 = P.startFrame(true, false);
  let guard2 = 0;
  while (f2 && !f2.done && guard2++ < 500) f2 = P.advance(f2, "merged", true, false);
  assert(f2.phase === "in" && f2.value === P.FAKE_IN, "merged in-only ends parked on the in cap");

  // preview segments read a sites fixture: { site: {unit,font,color} }
  const AUTO_SITES = {
    input: { unit: "auto", font: 0, color: "" },
    output: { unit: "auto", font: 0, color: "" },
    perOp: { unit: "auto", font: 0, color: "" },
  };
  const segText = (mode, frame, showIn, showOut, sites) =>
    P.segmentsText(P.badgeSegments(mode, frame, showIn, showOut, sites || AUTO_SITES));

  // split: in fills first, then out fills while both stay in the text.
  let f3 = P.startFrame(true, true);
  let sawBoth = false;
  let guard3 = 0;
  while (f3 && !f3.done && guard3++ < 500) {
    f3 = P.advance(f3, "split", true, true);
    const text = segText("split", f3, true, true);
    if (/in [\d.]+[A-Z]* token · out [\d.]+[A-Z]* token/.test(text)) sawBoth = true;
    assert(f3.inValue <= P.FAKE_IN && f3.outValue <= P.FAKE_OUT, "split values stay under caps");
  }
  assert(f3.done && f3.inValue === P.FAKE_IN && f3.outValue === P.FAKE_OUT, "split fills in then out to caps");
  assert(sawBoth, "split text shows in AND out together");

  // badge text respects the switches: in hidden -> never shows "in".
  const mergedInText = segText("merged", { phase: "in", value: 500 }, false, true);
  assert(mergedInText === "" || /^out /.test(mergedInText), "merged hides in when showInput is off (got '" + mergedInText + "')");
  const splitText = segText("split", { inValue: 100, outValue: 20 }, false, true);
  assert(splitText === "out 20 token", "split drops the in segment when showInput is off (got '" + splitText + "')");

  // no hover -> static idle frame with the full fake figures (auto-scaled:
  // 1866 -> 1.9K, 348 stays raw).
  const idle = segText("split", P.idleFrame("split", true, true), true, true);
  assert(idle === "in 1.9K token · out 348 token", "idle card shows complete fake counts under auto units (got '" + idle + "')");

  // a FIXED unit applies to its site only, and carries into the preview.
  const fixedIn = segText("split", { inValue: P.FAKE_IN, outValue: P.FAKE_OUT }, true, true, {
    input: { unit: "K", font: 0, color: "" },
    output: { unit: "auto", font: 0, color: "" },
    perOp: { unit: "auto", font: 0, color: "" },
  });
  assert(fixedIn === "in 1.9K token · out 348 token", "fixed K unit formats only the in site (got '" + fixedIn + "')");
  const fixedM = segText("split", { inValue: P.FAKE_IN, outValue: P.FAKE_OUT }, true, true, {
    input: { unit: "M", font: 0, color: "" },
    output: { unit: "auto", font: 0, color: "" },
    perOp: { unit: "auto", font: 0, color: "" },
  });
  assert(fixedM === "in 0M token · out 348 token", "fixed M on a small number rounds to 0M (the user chose the unit) (got '" + fixedM + "')");

  // segments carry per-site style for the renderer to attach.
  const styled = P.badgeSegments("split", { inValue: 100, outValue: 200 }, true, true, {
    input: { unit: "auto", font: 16, color: "#ff0000" },
    output: { unit: "auto", font: 0, color: "" },
    perOp: { unit: "auto", font: 0, color: "" },
  });
  assert(styled[0].font === 16 && styled[0].color === "#ff0000", "in segment carries its site's font/color");
  assert(styled[1].font === 0 && styled[1].color === "", "out segment keeps the inherited style");

  assert(P.startFrame(false, false) === null, "both switches off -> nothing to animate");

  // ── unit formatting itself ──
  const F = mod.tokens.format;
  assert(F(0, "auto") === "0", "0 -> 0");
  assert(F(999, "auto") === "999", "999 stays raw");
  assert(F(1000, "auto") === "1K", "1000 -> 1K");
  assert(F(1500, "auto") === "1.5K", "1500 -> 1.5K");
  assert(F(999_999, "auto") === "1M", "999999 promotes instead of 1000K");
  // review run 5c327ff6 P1: Math.round is half-up, so the promotion boundary
  // is 999.5, NOT 999.95 — the 999.5–999.94 interval must also promote.
  assert(F(999_500, "auto") === "1M", "999500 -> 1M (rounds to 1000K otherwise)");
  assert(F(999_499, "auto") === "999K", "999499 stays 999K (rounds down)");
  assert(F(999_949, "K") === "1M", "fixed K promotes at the 999.5 boundary");
  // review P3: fixed units promote STEPWISE, never strand at >=1000.
  assert(F(1_000_000_000, "K") === "1G", "1e9 locked to K promotes K->M->G");
  assert(F(999_949_999, "M") === "1G", "fixed M promotes at the boundary too");
  assert(F(1e15, "K") === "1000T", "T is the top: beyond it caps at 1000T");
  assert(F(2_500_000, "auto") === "2.5M", "2.5M");
  assert(F(3_200_000_000, "auto") === "3.2G", "3.2G");
  assert(F(1_500_000_000_000, "auto") === "1.5T", "1.5T");
  assert(F(1234, "K") === "1.2K", "fixed K always scales");
  assert(F(500, "K") === "0.5K", "fixed K under-scales small values (user chose it)");
  assert(F(999_999, "K") === "1M", "fixed K never prints 1000K");
  assert(F(1234, "auto") === "1.2K", "auto keeps one decimal below 100 scaled");
  assert(mod.tokens.sanitizeFont("16") === 16 && mod.tokens.sanitizeFont(-5) === 0 && mod.tokens.sanitizeFont(500) === 96,
    "font sanitizer clamps 0..96");
  assert(mod.tokens.sanitizeColor("#ff0000") === "#ff0000" && mod.tokens.sanitizeColor("red; } body{display:none}") === "",
    "color sanitizer admits hex only (no CSS injection)");
  // review P3: the member test must be own-property — inherited keys like
  // "constructor"/"__proto__" would otherwise leak through as "valid" units.
  {
    const U = mod.tokens ? mod.tokens.sanitizeUnit : undefined;
    assert(typeof U === "function", "sanitizeUnit exported for tests");
    assert(U("auto") === "auto" && U("K") === "K" && U("T") === "T", "real units pass through");
    assert(U("constructor") === "auto" && U("__proto__") === "auto" && U("toString") === "auto",
      "inherited prototype keys sanitize to auto");
    assert(U(undefined) === "auto" && U("X") === "auto" && U(42) === "auto", "junk sanitizes to auto");
    assert(F(1234, U("constructor")) === "1.2K", "a leaked prototype unit can never reach formatTokens");
  }
  const style = mod.tokens.siteStyle(0, "");
  assert(Object.keys(style).length === 0, "0/'' style emits nothing (inherits the row)");
}

// ── 7e) MODEPREVIEWCARD mounted: the component itself, through the hook ──
// runner, with real interval driving. This executes the timer start/restart/
// cleanup paths the pure-function tests cannot reach.
{
  const P = mod.preview;
  setCfg({ displayMode: "merged", showInput: true, showOutput: true, showPerOp: true });
  if (cfgListener) cfgListener();
  const tree = renderCard(bySlot("settings.section"), { view: "page" });
  const layout = childrenOf(childrenOf(tree)[2]);        // form body = dtc-layout div
  const previewsEl = childrenOf(layout)[0];              // first section = previews
  const cardsEl = childrenOf(previewsEl)[1];             // head, then cards grid
  const mergedCard = childrenOf(cardsEl)[0];
  const Card = mergedCard.type;
  const baseProps = { ...mergedCard.props, onSelect: (v) => edits.push(["mounted", v]) };

  const runner = makeHookRunner();
  activeHooks = runner;
  const findBadge = (node) => {
    if (!node || typeof node !== "object") return null;
    if (node.props && node.props["data-dsh-where-did-my-tokens-go"] === "true") return node;
    const kids = node.props && node.props.children;
    const list = Array.isArray(kids) ? kids : [kids];
    for (const k of list) { const hit = findBadge(k); if (hit) return hit; }
    return null;
  };
  // Badge layers: children[0] is the static content span; its children are the
  // segment nodes, so flatten the subtree back into one string.
  const nodeText = (n) => {
    if (n === null || n === undefined) return "";
    if (typeof n === "string") return n;
    const inner = n.props && n.props.children;
    return Array.isArray(inner) ? inner.map(nodeText).join("") : nodeText(inner);
  };
  const badgeTextOf = (el) => (el && el.props.children[0] ? nodeText(el.props.children[0]) : null);
  const findOpRow = (node) => {
    if (!node || typeof node !== "object") return null;
    if (node.props && node.props.className === "dtc-opRow") return node;
    const kids = node.props && node.props.children;
    const list = Array.isArray(kids) ? kids : [kids];
    for (const k of list) { const hit = findOpRow(k); if (hit) return hit; }
    return null;
  };
  // Events set state through effects; React would re-render after the effect
  // commits, so render twice to observe state an effect just wrote.
  const draw = (props) => { runner.render(Card, props); return runner.render(Card, props); };

  // Mount (no hover): idle merged badge shows the static out figure, no live
  // shimmer layers, and the op row is present.
  let rendered = draw(baseProps);
  let badge = findBadge(rendered);
  assert(badge && badgeTextOf(badge) === "out " + P.FAKE_OUT + " token", "mounted idle card shows static out figure (got '" + badgeTextOf(badge) + "')");
  assert(badge.props["data-dtc-live"] === "false", "idle card is not live");
  assert(findOpRow(rendered) !== null, "mounted card includes the use-token operation row");

  // Hover: the climb starts from zero and advances on each timer tick.
  rendered.props.onMouseEnter();
  rendered = draw(baseProps);
  badge = findBadge(rendered);
  const timerId = Math.max(...intervals.keys());
  assert(timerId > 1, "the hover animation registered its own interval (the live poll is id 1)");
  assert(badge.props["data-dtc-live"] === "true", "hover marks the card live");
  assert(badgeTextOf(badge) === "in 0 token", "hover frame starts the in climb at 0 (got '" + badgeTextOf(badge) + "')");
  intervals.get(timerId)();
  rendered = draw(baseProps);
  const climbed = badgeTextOf(findBadge(rendered));
  assert(/^in \d+ token$/.test(climbed) && climbed !== "in 0 token", "timer tick advances the in climb (got '" + climbed + "')");

  // Flipping showPerOp re-renders but MUST NOT restart the animation (it is
  // deliberately absent from the effect deps).
  intervals.get(timerId)();
  draw(baseProps);
  const idsBefore = intervals.size;
  const beforeProps = { ...baseProps, showPerOp: false };
  rendered = draw(beforeProps);
  assert(findOpRow(rendered) === null, "showPerOp off removes the operation row");
  assert(intervals.size === idsBefore, "per-op toggle registered no new interval (no restart)");
  intervals.get(timerId)();
  rendered = draw(beforeProps);
  assert(/^in \d+ token$/.test(badgeTextOf(findBadge(rendered))), "in climb continues after per-op toggle (got '" + badgeTextOf(findBadge(rendered)) + "')");

  // Leave: timer cleaned, back to the idle figure.
  rendered.props.onMouseLeave();
  rendered = draw(beforeProps);
  badge = findBadge(rendered);
  assert(badge.props["data-dtc-live"] === "false" && badgeTextOf(badge) === "out " + P.FAKE_OUT + " token", "leaving returns to the static idle figure");

  // Keyboard activation prevents default (space would otherwise scroll) and
  // selects the mode.
  let prevented = 0;
  rendered.props.onKeyDown({ key: " ", preventDefault: () => { prevented += 1; } });
  assert(prevented === 1, "space keydown calls preventDefault");
  assert(edits.some(([f, v]) => f === "mounted" && v === "merged"), "space activates the card");

  // Unmount clears the card timer: hover again so a timer IS live, then unmount.
  rendered.props.onMouseEnter();
  draw(beforeProps);
  const timerId2 = Math.max(...intervals.keys());
  assert(timerId2 > 1 && intervals.has(timerId2), "re-hover registers a fresh timer");
  runner.unmount();
  assert(!intervals.has(timerId2), "unmount clears the card timer");

  // Disabled card: not focusable, no click handler, hover does not animate.
  activeHooks = null;
  const disabledProps = { ...baseProps, disabled: true };
  const runner2 = makeHookRunner();
  activeHooks = runner2;
  const staticRender = runner2.render(Card, disabledProps);
  assert(staticRender.props.tabIndex === -1, "disabled card is out of the tab order");
  assert(staticRender.props.onKeyDown === undefined && staticRender.props.onClick === undefined, "disabled card has no click/key handlers");
  staticRender.props.onMouseEnter();
  badge = findBadge(runner2.render(Card, disabledProps));
  assert(badge.props["data-dtc-live"] === "false", "disabled card never animates on hover");
  runner2.unmount();
  activeHooks = null;
}

const summaryEl = renderCard(sectionEntry, { view: "summary" });
assert(summaryEl.type === "p" && childrenOf(summaryEl) === "description", "summary view renders the one-liner");

// ── cleanup ─────────────────────────────────────────────────────────
for (const clean of effects) { try { clean(); } catch (e) {} }
const spanAfterCleanup = runningContent.children.find((c) => c.getAttribute("data-dsh-where-did-my-tokens-go") === "true");
assert(spanAfterCleanup === undefined, "cleanup removes the counter span");

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
