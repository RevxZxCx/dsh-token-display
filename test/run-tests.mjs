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
    get firstElementChild() { return this.children[0] ?? null; },
    get lastElementChild() { return this.children[this.children.length - 1] ?? null; },
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
const window = {
  setInterval: (cb) => { intervalCb = cb; return 1; },
  clearInterval: () => { intervalCb = null; }
};
const sandboxSetTimeout = (fn) => { rafQueue.push(fn); return rafQueue.length; };
const sandboxClearTimeout = () => {};

// ── react + primitives mocks ────────────────────────────────────────
// Faithful to the real react/jsx-runtime signature: jsx(type, config, maybeKey).
// Children ONLY arrive through config.children; a third positional argument is
// a React key. Call sites that pass children positionally render EMPTY elements
// in the real app, so the mock models the key argument instead of swallowing
// extra arguments into a children list.
const jsx = (type, props, key) => ({ type, props, key });
const jsxs = jsx;

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
function counterSpan() {
  return runningContent.children.find((c) => c.getAttribute("data-dsh-token-counter") === "true") || null;
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
cfgValue = { displayMode: "split", showInput: true, showOutput: true, showPerOp: true };
if (cfgListener) cfgListener();
flushRaf();
assert(counterText() === "in 100 token · out 42 token", "split: 'in 100 token · out 42 token' (got '" + counterText() + "')");

// 4) showOutput off (split) -> input only
cfgValue = { displayMode: "split", showInput: true, showOutput: false, showPerOp: true };
if (cfgListener) cfgListener();
flushRaf();
assert(counterText() === "in 100 token", "split + showOutput off -> 'in 100 token' (got '" + counterText() + "')");

// 5) step/start resets: merged shows the input count again
cfgValue = { displayMode: "merged", showInput: true, showOutput: true, showPerOp: true };
if (cfgListener) cfgListener();
binding.eventSource._emit("append", [{ type: "event", event: { type: "step/start" } }]);
flushRaf();
assert(counterText() === "in 5000 token", "merged after step/start -> priced prompt, 'in 5000 token' (got '" + counterText() + "')");

// 5a) prefill phase: with no recognised events yet, the badge still prices input
{
  binding.eventSource._emit("replace", []);
  projectedTokens = 6100;
  flushRaf();
  assert(counterText() === "in 6100 token", "merged prefill without events -> 'in 6100 token' (got '" + counterText() + "')");
  // authoritative settle value outranks the priced projection
  binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/message", data: { turn: 9, step: 0, usage: { inputTokens: 777, outputTokens: 5 } } } }]);
  flushRaf();
  assert(counterText() === "out 5 token", "merged output phase shows out (got '" + counterText() + "')");
  // a new step re-prices from the projection (the old settle value is not the new prompt)
  binding.eventSource._emit("append", [{ type: "event", event: { type: "step/start" } }]);
  flushRaf();
  assert(counterText() === "in 6100 token", "merged after step/start re-reads the projection (got '" + counterText() + "')");
}

// 5b) merged + showInput off: prefill shows the output counter, never a blank row
cfgValue = { displayMode: "merged", showInput: false, showOutput: true, showPerOp: true };
if (cfgListener) cfgListener();
binding.eventSource._emit("append", [{ type: "event", event: { type: "step/start" } }]);
flushRaf();
assert(counterText() === "out 0 token", "merged + showInput off during prefill -> falls back to out (got '" + counterText() + "')");

// 5c) split mode keeps both counts visible through the whole turn
cfgValue = { displayMode: "split", showInput: true, showOutput: true, showPerOp: true };
if (cfgListener) cfgListener();
binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/live-chunk", data: { chunk: chunk("text-delta", "abcd") } } }]);
flushRaf();
assert(counterText() === "in 6100 token · out 1 token", "split during output keeps in + out (got '" + counterText() + "')");

// 5c-2) a deployment that ships no projection falls back to the last input learned
{
  cfgValue = { displayMode: "merged", showInput: true, showOutput: true, showPerOp: true };
  if (cfgListener) cfgListener();
  binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/message", data: { turn: 12, step: 0, usage: { inputTokens: 4321, outputTokens: 9 } } } }]);
  flushRaf();
  projectedTokens = undefined;              // contextPressure absent entirely
  binding.eventSource._emit("append", [{ type: "event", event: { type: "step/start" } }]);
  flushRaf();
  assert(counterText() === "in 4321 token", "no projection -> prefill falls back to last known input (got '" + counterText() + "')");
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
  assert(content.className === "dsh-token-counter-content", "first layer is the static content");
  assert(dec.getAttribute("aria-hidden") === "true" && dec.getAttribute("inert") === "", "overlay is aria-hidden and inert");
  const sweep = dec.children[0];
  assert(sweep.className === "dsh-token-counter-sweep", "overlay wraps the travelling mask");
  const highlight = sweep.children[0];
  assert(highlight.className === "dsh-token-counter-content dsh-token-counter-highlight", "mask wraps the counter-travelling highlight");
  assert(highlight.textContent === content.textContent, "highlight duplicates the content text (masked tint, not a moving copy)");

  // A text change must land in BOTH layers, or the tint desyncs from the glyphs.
  cfgValue = { displayMode: "split", showInput: true, showOutput: true, showPerOp: true };
  if (cfgListener) cfgListener();
  projectedTokens = 6200;
  runPoll();
  const span2 = counterSpan();
  assert(span2 === span, "badge node is reused across updates (no flicker)");
  assert(/in 6200 token/.test(span2.children[0].textContent),
    "content layer updated (got '" + span2.children[0].textContent + "')");
  const hl2 = span2.children[1].children[0].children[0];
  assert(hl2.textContent === span2.children[0].textContent,
    "highlight layer updated in lockstep (got '" + hl2.textContent + "')");
  assert(styleStore.get("dsh-token-counter-style").textContent.includes("dsh-token-counter-highlight"), "counter-moving keyframes shipped");
  assert(styleStore.get("dsh-token-counter-style").textContent.includes("--dsw-alias-label-shimmer"), "highlight color inherits the row's shimmer variable");
  assert(styleStore.get("dsh-token-counter-style").textContent.includes("font:inherit"), "badge inherits the running row's font");
}

// 5f) per-OPERATION attribution: two completed operations in ONE reply must show
// their OWN steps' usage, never the same whole-reply total (the old bug).
{
  cfgValue = { displayMode: "merged", showInput: true, showOutput: true, showPerOp: true };
  if (cfgListener) cfgListener();

  // Step 0 of turn 2 settles while rowA is the open row.
  binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/message", data: { turn: 2, step: 0, usage: { inputTokens: 1000, outputTokens: 20 } } } }]);
  runPoll();
  assert(useTokenOf(rowA) === "use 1020 token", "rowA shows its own step (1000+20) (got '" + useTokenOf(rowA) + "')");
  assert(useTokenOf(rowB) === null, "rowB has no number before its step settles (got '" + useTokenOf(rowB) + "')");
  assert(useTokenOf(rowLive) === null, "the streaming row shows nothing");

  // Step 1 settles; rowB is now closed and takes the NEXT step, not the running total.
  binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/message", data: { turn: 2, step: 1, usage: { inputTokens: 1200, outputTokens: 30 } } } }]);
  runPoll();
  assert(useTokenOf(rowB) === "use 1230 token", "rowB shows its own step (1200+30), not the reply total (got '" + useTokenOf(rowB) + "')");
  assert(useTokenOf(rowA) === "use 1020 token", "rowA keeps its own figure after a later step lands");
  assert(useTokenOf(rowA) !== useTokenOf(rowB), "the two operations show DIFFERENT numbers");

  // A re-settled step replaces its figure rather than accumulating.
  binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/message", data: { turn: 2, step: 1, usage: { inputTokens: 1200, outputTokens: 50 } } } }]);
  runPoll();
  assert(useTokenOf(rowB) === "use 1250 token", "re-settled step re-prices, never double counts (got '" + useTokenOf(rowB) + "')");

  // totalTokens wins when the provider reports it, and a row only earns its
  // number once it closes.
  binding.eventSource._emit("append", [{ type: "event", event: { type: "assistant/message", data: { turn: 2, step: 2, usage: { inputTokens: 900, outputTokens: 5, totalTokens: 905 } } } }]);
  runPoll();
  assert(useTokenOf(rowLive) === null, "still-streaming row stays unnumbered even after its step settles");
  liveShimmer.remove();
  runPoll();
  assert(useTokenOf(rowLive) === "use 905 token", "closing the row paints its own step, preferring totalTokens (got '" + useTokenOf(rowLive) + "')");
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
  assert(useTokenOf(r5a) === "use 2040 token", "reload: first row numbers its own step (got '" + useTokenOf(r5a) + "')");
  assert(useTokenOf(r5b) === "use 2460 token", "reload: second row numbers its own step (got '" + useTokenOf(r5b) + "')");
  assert(useTokenOf(r5a) !== useTokenOf(r5b), "reload: rows still differ (no shared total)");
}

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

for (const seatName of ["settings.section", "settings.plugins.tab", "plugins.bundle.config", "plugins.item"]) {
  const entry = bySlot(seatName);
  if (!entry) continue;
  const tree = renderCard(entry, { view: "page" });
  assert(tree && tree.type !== "p", seatName + ": card renders an element tree");
  if (seatName === "settings.section" || seatName === "settings.plugins.tab") {
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
const formChildren = childrenOf(formEl);
assert(formChildren && formChildren.type === "div", "settings form body is the control group");
const controls = childrenOf(formChildren);
assert(Array.isArray(controls) && controls.length === 4, "control group holds the mode picker + 3 switches");
assert(controls[0].type === primitivesMock.SegmentedControl, "first control is the display-mode picker");
assert(controls.slice(1).every((c) => c.type === "div"), "each switch is wrapped in a labelled row");
const rowKids = childrenOf(controls[1]);
assert(Array.isArray(rowKids) && rowKids[0].props.children === "showInput" && rowKids[1].type === primitivesMock.Switch,
  "switch row carries a visible caption plus the platform switch");

const modeProps = childrenOf(formChildren)[0].props;
assert(modeProps.options.length === 2 && modeProps.value === cfgValue.displayMode,
  "mode picker reflects the served value ('" + cfgValue.displayMode + "') and offers merged/split");

const summaryEl = renderCard(sectionEntry, { view: "summary" });
assert(summaryEl.type === "p" && childrenOf(summaryEl) === "description", "summary view renders the one-liner");

// ── cleanup ─────────────────────────────────────────────────────────
for (const clean of effects) { try { clean(); } catch (e) {} }
const spanAfterCleanup = runningContent.children.find((c) => c.getAttribute("data-dsh-token-counter") === "true");
assert(spanAfterCleanup === undefined, "cleanup removes the counter span");

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
