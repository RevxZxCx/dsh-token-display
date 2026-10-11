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
const name = "dsh-token-counter";
const clientPath = join(root, name, "lib", "client.js");
const st = statSync(clientPath);
const rev = artifactRevision(st);
const url = `http://${HOST}:${PORT}/plugins/??${name}/client.js&rev=${rev}`;
const res = await fetch(url, { redirect: "manual" });
const buf = Buffer.from(await res.arrayBuffer());
const text = buf.toString("utf8");
console.log(`status=${res.status} servedBytes=${buf.byteLength} diskBytes=${st.size} rev=${rev}`);
console.log("contains buildBadge:", text.includes("buildBadge"));
console.log("contains data-dsh-token-counter:", text.includes("data-dsh-token-counter"));
console.log("contains data-dsh-use-token:", text.includes("data-dsh-use-token"));
console.log('contains inject=["sessions","slots","locale","configForms"]:', text.includes('["sessions", "slots", "locale", "configForms"]'));
console.log("contains TokenCounterCard:", text.includes("TokenCounterCard"));
console.log("id line:", text.match(/id: "([^"]+)"/)?.[0]);
