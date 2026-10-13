/**
 * dsh-where-did-my-tokens-go — host (Node) half.
 *
 * Exposes a schemastery Config so the DSH settings service auto-projects the
 * plugin's editable options into the Plugins page under namespace
 * "dsh-where-did-my-tokens-go" (= this profile entry id). Every editable field is
 * `.volatile()` (required by `volatileForm`), and we mark the presentation
 * `{ auto: false }` so our custom client card is shown instead of a generic
 * generated form.
 *
 * This mirrors @deepseek-ai/dsh-client-ui-chat/lib/index.js exactly: a plain
 * named `Config` export + a plain `apply` that configures the settings page.
 */
import z from "@deepseek-ai/schemastery";

// Per-site unit lock: "auto" scales K/M/G/T by magnitude; a fixed unit is
// always used for that site. Font 0 = follow the host row's own size; color
// "" = follow the row's inherited color.
const unitField = () => z.union(["auto", "K", "M", "G", "T"]).default("auto").volatile();

const Config = z.object({
  // merged: show only in (input phase) or only out (output phase).
  // split : always show "in N token · out M token".
  displayMode: z.union(["merged", "split"]).default("merged").volatile(),
  showInput: z.boolean().default(true).volatile(),
  showOutput: z.boolean().default(true).volatile(),
  showPerOp: z.boolean().default(true).volatile(),
  // per-site styling (the three switches' gear menus)
  inputUnit: unitField(),
  outputUnit: unitField(),
  perOpUnit: unitField(),
  inputFont: z.number().default(0).volatile(),
  outputFont: z.number().default(0).volatile(),
  perOpFont: z.number().default(0).volatile(),
  inputColor: z.string().default("").volatile(),
  outputColor: z.string().default("").volatile(),
  perOpColor: z.string().default("").volatile(),
});

function apply(ctx) {
  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
}

export { Config, apply };
