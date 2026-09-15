import type { DiscriminatedUnionIR, LiteralValue, ObjectIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { declareFastTemps, escapeString, extendPath, literalToJs } from "../context.js";
import { emit } from "../emit.js";
import { invalidType } from "../emit-issue.js";

/** One `discriminator value → option index` dispatch entry. */
type DiscriminatorCase = DiscriminatedUnionIR["cases"][number];

export function slowDiscriminatedUnion(
  ir: SchemaIR & { type: "discriminatedUnion" },
  g: SlowGen,
): string {
  const discKey = escapeString(ir.discriminator);

  let code = emit`
    if(typeof ${g.input}!=="object"||${g.input}===null||Array.isArray(${g.input})){
      ${invalidType(g, "object", { codeFirst: true })}
    }else{`;

  const objVar = g.temp("du");
  code += `var ${objVar}=${g.input};switch(${objVar}[${discKey}]){`;

  for (const { value, option: index } of ir.cases) {
    const option = ir.options[index] as SchemaIR;
    code += emit`
      case ${literalToJs(value)}:
        ${g.visit(option, { input: objVar, output: objVar })}
        break;`;
  }

  const msgProp = g.typeMsg === undefined ? "" : `,message:${JSON.stringify(g.typeMsg)}`;
  // Field for field what $ZodDiscriminatedUnion pushes when no option matches:
  // `{ code, errors: [], note: "No matching discriminator", discriminator,
  // options, input, path: [def.discriminator] }`. `options` is
  // `Array.from(disc.value.keys())` — every dispatch value in map insertion
  // order, which is exactly `ir.cases` (option order, then each option's
  // `propValues[discriminator]` in ITS order, so an omittable discriminator
  // lists `undefined` right after its own values). The locale reads the list
  // for "Invalid discriminator value. Expected 'a' | 'b'". A fresh array
  // literal per push, as zod allocates one, so consumers never share or
  // mutate a hoisted table.
  const optionsList = ir.cases.map(({ value }) => literalToJs(value)).join(",");
  code += emit`
    default:
      ${g.issues}.push({code:"invalid_union",errors:[],note:"No matching discriminator",discriminator:${discKey},options:[${optionsList}],input:${g.input},path:${extendPath(g.path, discKey)}${msgProp}});
    }`;
  // Propagate what the matched option produced back to the output location.
  // Each option is visited with output:objVar — a fresh local — so its result is
  // reassigned into objVar and stranded there; without this write-back the
  // caller gets the ORIGINAL input by reference and the result is silently lost.
  // That is as true of an option that rewrites nothing as of a mutating one
  // (defaults, coercions, transforms, overwrite checks, stringbool): it can
  // still hand back a replacement — a `__proto__`-scrubbed copy, or a copy a
  // nested replacement landed on — so the write is not gated on mutation. Where
  // nothing was replaced, and on the no-match path, objVar is still the input.
  code += `${g.output}=${objVar};`;
  code += `}`;
  return `${code}\n`;
}

/**
 * Emit an O(1) switch-dispatch fast-check for a discriminated union — real
 * (`z.discriminatedUnion`) or one detected inside a plain `z.union`
 * (see {@link detectUnionDiscriminator}). Both share this so the detected case
 * inherits the size-gating and the per-case guard strip.
 *
 * `discSkipKey` tells each object option to drop its own type-guard and
 * discriminator re-check: the caller's guard (`typeof x==="object"&&…` below)
 * already proved object-ness, and the matched switch case has fixed the
 * discriminator value, so re-emitting either is pure redundancy the optimizer
 * only removes when it inlines this helper — which a union large enough to
 * matter won't. Routed through the normal `visit` so size-gated extraction
 * still bounds the switch (the strip survives into any hoisted helper);
 * non-object options ignore the hint and keep their own guard.
 *
 * Returns null if any option is fast-path-ineligible.
 */
export function emitFastDiscriminatedSwitch(
  g: FastGen,
  discriminator: string,
  cases: readonly DiscriminatorCase[],
  options: readonly SchemaIR[],
): string | null {
  const x = g.input;
  const discKey = escapeString(discriminator);
  const helperName = g.temp("du");
  const helperParam = g.temp("dx");

  // The switch body is its own function: size-gate the options against the cap
  // in a fresh scope, otherwise many small options accumulate into the caller's
  // scope while this helper itself grows unbounded past the TurboFan budget.
  //
  // The switch is over the literal labels themselves. An earlier revision
  // routed three or more string labels through a `{value: ordinal}` table and
  // switched on the ordinal, on the theory that V8 compiles a string switch as
  // sequential comparisons and a dense integer one as a jump table. Measured on
  // V8 13.x (node 24) that is a loss at every size: the table's `t[v]` is a
  // keyed load whose key varies per parse, which goes megamorphic the moment
  // the input rotates through the options, while the string switch stays
  // nearly flat (8.6 ns at 8 cases, 10.1 at 32, 17.3 at 80, rotating input)
  // against the table's 12.9, 15.8 and 20.8. The build path switches the same
  // way (see `buildDispatch`).
  const body = g.scoped(helperParam);
  const caseStrs: string[] = [];
  for (const { value, option: index } of cases) {
    const check = body.visit(options[index] as SchemaIR, { discSkipKey: discriminator });
    if (check === null) return null;
    caseStrs.push(`case ${literalToJs(value)}:return ${check};`);
  }
  g.ctx.preamble.push(
    `function ${helperName}(${helperParam}){${declareFastTemps(body.scope)}switch(${helperParam}[${discKey}]){${caseStrs.join("")}default:return false;}}`,
  );

  return `typeof ${x}==="object"&&${x}!==null&&!Array.isArray(${x})&&${helperName}(${x})`;
}

export function fastDiscriminatedUnion(ir: DiscriminatedUnionIR, g: FastGen): string | null {
  return emitFastDiscriminatedSwitch(g, ir.discriminator, ir.cases, ir.options);
}

/**
 * Minimum option count for rewriting a plain `z.union` to switch dispatch. Below
 * this the switch helper's fixed call overhead loses to a fully-inlined
 * `||`-chain that V8 keeps flat: measured crossover is ~4 options (n=3 can hit
 * 0.6x — a regression — while n=5 is 1.27x and n=32 is 2.34x), so 5 captures the
 * stable wins with margin and never regresses a small union. Real
 * `z.discriminatedUnion` is unaffected — it dispatches via switch by construction
 * regardless of size.
 */
const MIN_AUTO_DISCRIMINATE_OPTIONS = 5;

/**
 * Values that switch correctly under `===` (excludes `undefined` and `NaN`).
 *
 * Also excludes a SYMBOL — now that `LiteralIR.values` admits one, this is the
 * guard that keeps it out. A symbol discriminant has no source form, so there
 * is no `case` label to emit for it (`literalToJs` refuses it by type), and the
 * ordinal-table variant is string-keyed besides. Detection bails to the
 * `||`-chain, where the option's own literal check does the right thing by
 * reading the value list off the retained schema.
 */
function isSwitchableDiscriminant(v: LiteralValue): v is string | number | boolean | bigint | null {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "boolean" ||
    typeof v === "bigint" ||
    (typeof v === "number" && !Number.isNaN(v))
  );
}

/**
 * Detect whether a plain (untagged) `z.union` is *structurally* a discriminated
 * union, so its fast path can use O(1) switch dispatch instead of probing every
 * arm. Returns the discriminator + dispatch table, or null to keep the
 * `||`-chain.
 *
 * Requires (proving the switch accepts exactly what the `||`-chain would): every
 * option is a plain object that pins one shared key to a REQUIRED literal
 * (`prop.type === "literal"` — an optional/non-literal key is rejected), and the
 * literal values are pairwise DISJOINT across options. Disjointness is the crux:
 * it guarantees at most one option can accept any given input, so dispatching to
 * that single option is equivalent to trying them all. Any value shared by two
 * options (ambiguous), a non-switchable value (`undefined`/`NaN`), or a
 * non-object option makes detection bail to the safe `||`-chain.
 *
 * The slow path is untouched: it keeps `z.union`'s sequential trial and its
 * `invalid_union` error shape, so failure output stays byte-identical to Zod.
 * The fast path and the build path both dispatch on the result — the build
 * path from two options up (`minOptions`), since its options are hosted calls
 * either way and a switch only ever replaces probes with one call; see
 * `buildUnion`.
 */
export function detectUnionDiscriminator(
  options: readonly SchemaIR[],
  minOptions: number = MIN_AUTO_DISCRIMINATE_OPTIONS,
): { discriminator: string; cases: DiscriminatorCase[] } | null {
  if (options.length < minOptions) return null;
  const objects: ObjectIR[] = [];
  for (const option of options) {
    if (option.type !== "object") return null;
    objects.push(option);
  }
  const first = objects[0];
  if (first === undefined) return null; // unreachable (length checked above)

  // Only keys present in the first option can be shared by all; try each.
  candidate: for (const key of Object.keys(first.properties)) {
    const seen = new Set<string | number | boolean | bigint | null>();
    const cases: DiscriminatorCase[] = [];
    for (const [i, object] of objects.entries()) {
      const prop = object.properties[key];
      if (prop === undefined || prop.type !== "literal") continue candidate;
      for (const value of prop.values) {
        if (!isSwitchableDiscriminant(value)) continue candidate;
        if (seen.has(value)) continue candidate; // shared value → ambiguous dispatch
        seen.add(value);
        cases.push({ value, option: i });
      }
    }
    return { discriminator: key, cases };
  }
  return null;
}
