import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

const PORT = 19387;
const HOST = "127.0.0.1";

function framedHash(domain, parts) {
  const hash = createHash("sha1").update(domain).update("\0");
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
  return hash.digest("hex").slice(0, 12);
}
function artifactRevision(baseline) {
  return framedHash("plugin-artifact", [
    String(baseline.mtimeMs), String(baseline.ctimeMs), String(baseline.size)
  ]);
}

const root = "C:/Users/26903/.dsh/profiles/desktop/node_modules";
const name = "dsh-where-did-my-tokens-go";
const clientPath = join(root, name, "lib", "client.js");
const st = statSync(clientPath);
const rev = artifactRevision(st);
const url = `http://${HOST}:${PORT}/plugins/??${name}/client.js&rev=${rev}`;
const res = await fetch(url, { redirect: "manual" });
const buf = Buffer.from(await res.arrayBuffer());
const text = buf.toString("utf8");
console.log(`status=${res.status} servedBytes=${buf.byteLength} diskBytes=${st.size} rev=${rev}`);
console.log("contains buildBadge:", text.includes("buildBadge"));
console.log("contains data-dsh-where-did-my-tokens-go:", text.includes("data-dsh-where-did-my-tokens-go"));
console.log("contains data-dsh-use-token:", text.includes("data-dsh-use-token"));
console.log('contains inject=["sessions","slots","locale","configForms"]:', text.includes('["sessions", "slots", "locale", "configForms"]'));
console.log("contains TokenCounterCard:", text.includes("TokenCounterCard"));
console.log("labelled switch rows:", text.includes("dtc-switchRow"));
console.log("no positional-jsx call sites (1.3.1):", !/jsxs\(\s*"[a-z]+",\s*\{[^{}]*\},\s*\n?\s*jsx\(/.test(text));
console.log("platform shimmer geometry (1.3.2):", text.includes("dsh-where-did-my-tokens-go-highlight"));
console.log("counter-moving keyframes (1.3.2):", text.includes("@keyframes dsh-where-did-my-tokens-go-highlight"));
console.log("inherits row shimmer color (1.3.2):", text.includes("--dsw-alias-label-shimmer"));
console.log("reads contextPressure projection (1.3.2):", text.includes("contextPressure"));
console.log("per-step usage records (1.3.5):", text.includes("recordStep") && text.includes("stepRecords"));
console.log("no turn-level accumulator (1.3.5):", !text.includes("turnUsage"));
console.log("preview cards (1.4.0):", text.includes("ModePreviewCard") && text.includes("dtc-cards"));
console.log("no segmented control (1.4.0):", !text.includes("SegmentedControl"));
console.log("unit formatting (1.5.0):", text.includes("formatTokens") && text.includes("UNIT_SCALES"));
console.log("gear panels (1.5.0):", text.includes("GearPanel") && text.includes("dtc-gearPanel"));
console.log("badge segments (1.5.0):", text.includes("buildBadgeSegments") && text.includes("fillBadge"));
console.log("id line:", text.match(/id: "([^"]+)"/)?.[0]);
