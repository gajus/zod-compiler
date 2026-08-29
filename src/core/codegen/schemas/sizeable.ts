import type { CheckOrEffectIR, FileCheckIR, SetCheckIR } from "../../types.js";
import type { CodeGenContext, SlowGen } from "../context.js";
import { emitRuntimeHelper } from "../context.js";
import { emit } from "../emit.js";
import { tooBig, tooSmall } from "../emit-issue.js";
import { ZC_CPL_DECL, ZC_LENGTH_ORIGIN_DECL, ZC_SIZE_ORIGIN_DECL } from "../issue-decls.js";

/**
 * The UTF-16 unit count from which a string is CERTAINLY at least `min` code
 * points, so the count can be skipped.
 *
 * A code point is one or two units, so `codePoints >= ceil(units / 2)`, and
 * that ceiling is an integer: `ceil(units/2) >= min` holds exactly when
 * `ceil(units/2) >= Math.ceil(min)`, i.e. `units >= 2 * ceil(min) - 1`.
 * Rounding `min` up is what makes a FRACTIONAL bound safe — `min(2.5)` is
 * settled at 5 units, not the 4 that `2 * min - 1` would have claimed, where
 * two astral characters are only 2 code points and zod reports `too_small`.
 */
function certainlyAtLeast(min: number): number {
  return 2 * Math.ceil(min) - 1;
}

/**
 * String length tests over Unicode CODE POINTS, gated so the count is only
 * paid for when the UTF-16 unit count leaves the verdict in doubt.
 *
 * zod measures `z.string().min()/.max()/.length()` in code points
 * (`util.codePointLength`), so `"😀"` has length 1, and it computes that count
 * only when the unit count could sit on the other side of the bound. A code
 * point is one or two units, so `units/2 <= codePoints <= units` — which pins
 * the doubtful band tighter than zod's own gate without changing a verdict:
 * `min(N)` is settled outside `N <= units < 2*ceil(N)-1` (so `min(1)` stays a
 * plain `length>=1`; see {@link certainlyAtLeast} for the fractional case),
 * `max(N)` outside `N < units <= 2N`, and `length(N)` outside `N <= units <=
 * 2N`. Every test leads with the plain unit comparison, so an ASCII string of
 * ordinary length never reaches the helper.
 *
 * `mayNotBeString` adds the `typeof` guard zod applies (`typeof input ===
 * "string" && …`) for a site whose input is not statically a string — a
 * length check firing on the wrong type through its `when` predicate; an array
 * measures elements, never code points. Only the failure-direction forms take
 * it: `min`/`max`/`equals` are reached solely from `fastStringCheck`, whose
 * input is statically a string.
 */
export const stringLengthTests = {
  min(x: string, min: number, ctx: CodeGenContext): string {
    const units = `${x}.length>=${min}`;
    if (min <= 1) return units;
    const cpl = emitRuntimeHelper(ctx, "__zcCpl", ZC_CPL_DECL);
    return `${units}&&(${x}.length>=${certainlyAtLeast(min)}||${cpl}(${x})>=${min})`;
  },
  max(x: string, max: number, ctx: CodeGenContext): string {
    const units = `${x}.length<=${max}`;
    if (max <= 0) return units;
    const cpl = emitRuntimeHelper(ctx, "__zcCpl", ZC_CPL_DECL);
    return `(${units}||(${x}.length<=${2 * max}&&${cpl}(${x})<=${max}))`;
  },
  equals(x: string, length: number, ctx: CodeGenContext): string {
    if (length <= 0) return `${x}.length===${length}`;
    const cpl = emitRuntimeHelper(ctx, "__zcCpl", ZC_CPL_DECL);
    // A single unit is always one code point, so `length(1)` is only in doubt
    // at exactly two units.
    if (length === 1) {
      return `(${x}.length===1||(${x}.length===2&&${cpl}(${x})===1))`;
    }
    return `(${x}.length>=${length}&&${x}.length<=${2 * length}&&${cpl}(${x})===${length})`;
  },
  /**
   * The FAILING condition of `min`/`max`, with the negation pushed inward so a
   * check with no doubtful band emits the plain comparison the slow path always
   * used (`x.length<1`, not `!(x.length>=1)`).
   */
  minFails(x: string, min: number, ctx: CodeGenContext, mayNotBeString = false): string {
    const units = `${x}.length<${min}`;
    if (min <= 1) return units;
    const cpl = emitRuntimeHelper(ctx, "__zcCpl", ZC_CPL_DECL);
    const guard = mayNotBeString ? `typeof ${x}==="string"&&` : "";
    return `${units}||(${x}.length<${certainlyAtLeast(min)}&&${guard}${cpl}(${x})<${min})`;
  },
  maxFails(x: string, max: number, ctx: CodeGenContext, mayNotBeString = false): string {
    const units = `${x}.length>${max}`;
    if (max <= 0) return units;
    const cpl = emitRuntimeHelper(ctx, "__zcCpl", ZC_CPL_DECL);
    const guard = mayNotBeString ? `typeof ${x}!=="string"||` : "";
    return `${units}&&(${x}.length>${2 * max}||${guard}${cpl}(${x})>${max})`;
  },
  /**
   * The measured length zod compares in `$ZodCheckLengthEquals` — code points
   * inside the doubtful band, units outside it — for the slow path, which has
   * to know WHICH side of the bound the value fell on.
   */
  measure(x: string, length: number, ctx: CodeGenContext, mayNotBeString = false): string {
    if (length <= 0) return `${x}.length`;
    const cpl = emitRuntimeHelper(ctx, "__zcCpl", ZC_CPL_DECL);
    const guard = mayNotBeString ? `typeof ${x}==="string"&&` : "";
    const band =
      length === 1 ? `${x}.length===2` : `${x}.length>=${length}&&${x}.length<=${2 * length}`;
    return `(${guard}${band}?${cpl}(${x}):${x}.length)`;
  },
};

/**
 * Length/size checks re-emitted for the branch where the node's TYPE CHECK
 * ALREADY FAILED.
 *
 * zod skips a schema's checks once its parse aborted — except the ones carrying
 * a `when` predicate, which `runChecks` consults instead of the abort flag:
 *
 * ```js
 * if (ch._zod.def.when) { if (!ch._zod.def.when(payload)) continue; }
 * else if (isAborted) continue;
 * ```
 *
 * and `$ZodCheckMinLength` & co. install exactly such a predicate —
 * `!nullish(value) && value.length !== undefined` (`.size` for the size family)
 * — so they run on ANY input carrying that property, of any type. Hence
 * `z.string().min(2).safeParse([])` reports TWO issues in zod: the
 * `invalid_type`, and a `too_small` whose `origin` is `"array"`, because the
 * empty array satisfied the `when`. Compiled output kept every check inside the
 * matched-type branch and reported only the first. Same for
 * `z.array(…).min(3)` over a short string, `z.set(…).min(2)` over a `Map`, and
 * `z.file().min(2)` over a `Set`.
 *
 * Emitted as a SEPARATE copy in the failure branch rather than hoisted out of
 * both, so the success path — where the origin is statically known and the guard
 * is trivially true — stays byte-for-byte what it was. This is cold code: it
 * runs only for input the node has already rejected.
 *
 * `origin` is computed at runtime here (see ZC_LENGTH_ORIGIN_DECL), because the
 * value that reached this branch is by definition not the schema's own type.
 *
 * `mayBeString` is set by a non-string node whose length checks can fire on a
 * string (`z.array(…).min(2)` over `"😀"`): zod then measures it in code
 * points, so those tests take the guarded form of {@link stringLengthTests}. A
 * string node's own failure branch never holds a string and keeps the plain
 * unit comparison.
 */
export function whenGatedSizeChecks(
  checks: readonly (CheckOrEffectIR | SetCheckIR | FileCheckIR)[],
  g: SlowGen,
  family: "length" | "size",
  mayBeString = false,
): string {
  const KINDS =
    family === "length"
      ? new Set(["min_length", "max_length", "length_equals"])
      : new Set(["min_size", "max_size", "size_equals"]);
  // Checked BEFORE touching the context: `emitRuntimeHelper` pushes its
  // declaration on sight, so asking for the origin helper up front left a dead
  // `__zcLo` in the preamble of every schema with a plain `z.string()` in it.
  if (!checks.some((check) => KINDS.has(check.kind))) return "";

  const property = family === "length" ? "length" : "size";
  const originHelper =
    family === "length"
      ? emitRuntimeHelper(g.ctx, "__zcLo", ZC_LENGTH_ORIGIN_DECL)
      : emitRuntimeHelper(g.ctx, "__zcSo", ZC_SIZE_ORIGIN_DECL);
  const origin = { expr: `${originHelper}(${g.input})` };
  const measure = `${g.input}.${property}`;

  let body = "";
  for (const check of checks) {
    // Kept in DECLARATION order: `runChecks` walks the check array, so two
    // failing length checks report in the order they were declared.
    switch (check.kind) {
      case "min_length":
        body += emit`
          if(${mayBeString ? stringLengthTests.minFails(g.input, check.minimum, g.ctx, true) : `${measure}<${check.minimum}`}){
            ${tooSmall(g, check.minimum, origin, true, { message: check.message })}
          }`;
        break;
      case "max_length":
        body += emit`
          if(${mayBeString ? stringLengthTests.maxFails(g.input, check.maximum, g.ctx, true) : `${measure}>${check.maximum}`}){
            ${tooBig(g, check.maximum, origin, true, { message: check.message })}
          }`;
        break;
      case "length_equals": {
        const length = mayBeString
          ? stringLengthTests.measure(g.input, check.length, g.ctx, true)
          : measure;
        body += emit`
          if(${length}<${check.length}){
            ${tooSmall(g, check.length, origin, true, { exact: true, message: check.message })}
          }else if(${length}>${check.length}){
            ${tooBig(g, check.length, origin, true, { exact: true, message: check.message })}
          }`;
        break;
      }
      case "min_size":
        body += emit`
          if(${measure}<${check.minimum}){
            ${tooSmall(g, check.minimum, origin, true, { message: check.message })}
          }`;
        break;
      case "max_size":
        body += emit`
          if(${measure}>${check.maximum}){
            ${tooBig(g, check.maximum, origin, true, { message: check.message })}
          }`;
        break;
      case "size_equals":
        body += emit`
          if(${measure}<${check.size}){
            ${tooSmall(g, check.size, origin, true, { exact: true, message: check.message })}
          }else if(${measure}>${check.size}){
            ${tooBig(g, check.size, origin, true, { exact: true, message: check.message })}
          }`;
        break;
      default:
        break;
    }
  }
  if (body === "") return "";
  // zod's own `when`, verbatim: `!util.nullish(value) && value.<prop> !== undefined`.
  return emit`
    if(${g.input}!==undefined&&${g.input}!==null&&${measure}!==undefined){
      ${body}
    }`;
}
