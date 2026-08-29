import type { DiscriminatedUnionIR, LiteralValue, ObjectIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import {
  declareFastTemps,
  emitConstant,
  escapeString,
  extendPath,
  hasMutation,
  literalToJs,
} from "../context.js";
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
  // Propagate option-applied mutations (defaults, coercions, transforms,
  // overwrite checks, stringbool) back to the output location. Each option is
  // visited with output:objVar — a fresh local — so a mutating option's clone is
  // reassigned into objVar and stranded there; without this write-back the caller
  // returns the ORIGINAL input by reference and the mutation is silently lost.
  // Gated on mutation so a pure-validation union stays a zero-write pass-through
  // (objVar still aliases the input). On the no-match/failure paths objVar equals
  // the input, so the write is a harmless self-assignment.
  if (ir.options.some(hasMutation)) {
    code += `${g.output}=${objVar};`;
  }
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
  const body = g.scoped(helperParam);
  const table = stringDispatchTable(cases);

  if (table === null) {
    const caseStrs: string[] = [];
    for (const { value, option: index } of cases) {
      const check = body.visit(options[index] as SchemaIR, { discSkipKey: discriminator });
      if (check === null) return null;
      caseStrs.push(`case ${literalToJs(value)}:return ${check};`);
    }
    g.ctx.preamble.push(
      `function ${helperName}(${helperParam}){${declareFastTemps(body.scope)}switch(${helperParam}[${discKey}]){${caseStrs.join("")}default:return false;}}`,
    );
  } else {
    // Dispatch through a string→ordinal table, then switch on the ordinal. V8
    // compiles a switch over STRING labels as sequential `===` comparisons, so
    // the plain form costs ~0.5 ns per preceding case: measured 4.1 ns (2
    // variants), 11.4 (8), 52.1 (80). A dense integer switch becomes a jump
    // table, leaving the lookup flat — 5.9 ns (8) and 15.1 (80), i.e. 1.9x to
    // 3.5x, for a table that adds ~1.3% to a union's generated bytes.
    //
    // `typeof t==="string"` is load-bearing: property access would coerce a
    // non-string discriminator (an object's toString, a number) into a key that
    // could hit a case whose own discriminator check the switch has stripped.
    // Strict equality never matched those, so the guard keeps the verdict.
    const caseStrs: string[] = [];
    for (const [optionIndex, ordinal] of table.ordinals) {
      const check = body.visit(options[optionIndex] as SchemaIR, { discSkipKey: discriminator });
      if (check === null) return null;
      caseStrs.push(`case ${ordinal}:return ${check};`);
    }
    const tableVar = emitConstant(g.ctx, "dt", table.initializer);
    const t = g.temp("dv");
    g.ctx.preamble.push(
      `function ${helperName}(${helperParam}){${declareFastTemps(body.scope)}var ${t}=${helperParam}[${discKey}];` +
        `switch(typeof ${t}==="string"?${tableVar}[${t}]:0){${caseStrs.join("")}default:return false;}}`,
    );
  }

  return `typeof ${x}==="object"&&${x}!==null&&!Array.isArray(${x})&&${helperName}(${x})`;
}

/**
 * Minimum case count for ordinal dispatch. Measured crossover is 3: at 2 cases
 * the string switch is one comparison and beats the extra table lookup
 * (4.1 ns vs 4.5), at 3 the table already wins (6.1 vs 4.6).
 */
const MIN_TABLE_DISPATCH = 3;

/**
 * Build the `{value: ordinal}` dispatch table for a set of cases, or null when
 * the plain string switch should be kept. Requires every discriminator value to
 * be a string — mixed types would collide once coerced to property keys (`5`
 * and `"5"`) — and excludes `__proto__`, which an object literal cannot hold as
 * an own key. Values that select the SAME option share one ordinal, so a
 * multi-value literal emits its check once instead of per value.
 */
function stringDispatchTable(
  cases: readonly DiscriminatorCase[],
): { initializer: string; ordinals: Map<number, number> } | null {
  if (cases.length < MIN_TABLE_DISPATCH) return null;
  if (!cases.every((c) => typeof c.value === "string" && c.value !== "__proto__")) return null;

  const ordinals = new Map<number, number>();
  const entries: string[] = [];
  for (const { value, option } of cases) {
    let ordinal = ordinals.get(option);
    if (ordinal === undefined) {
      ordinal = ordinals.size + 1;
      ordinals.set(option, ordinal);
    }
    entries.push(`${escapeString(value as string)}:${ordinal}`);
  }
  return { initializer: `{${entries.join(",")}}`, ordinals };
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
 * Fast-path only: the slow path keeps `z.union`'s sequential trial and its
 * `invalid_union` error shape, so failure output stays byte-identical to Zod.
 */
export function detectUnionDiscriminator(
  options: readonly SchemaIR[],
): { discriminator: string; cases: DiscriminatorCase[] } | null {
  if (options.length < MIN_AUTO_DISCRIMINATE_OPTIONS) return null;
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
