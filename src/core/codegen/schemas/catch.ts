import type { CatchIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";

export function slowCatch(ir: SchemaIR & { type: "catch" }, g: SlowGen): string {
  const tempIssues = g.temp("ci");
  const idxVar = g.temp("ck");
  const cvVar = g.temp("cv");
  const inVar = g.temp("cin");
  // Mirrors $ZodCatch: on inner failure, catchValue receives a ctx of
  // { value, issues, error: { issues }, input } and its result replaces the
  // value; the issues are swallowed. Finalize messages first so ctx readers
  // see zod-shaped issues (one finalized array serves both fields).
  //
  // `value` and `input` are both the value the catch was HANDED, snapshotted
  // before the inner runs: zod runs the inner on a payload of its own and
  // spreads that, but overwrites `value` with the original input. The compiled
  // walk writes the inner's output through the same slot it reads from, so
  // without the snapshot a rebuilding inner (a strip object, a readonly) would
  // hand the callback its half-built copy instead.
  //
  // `input` is `delete`d, not assigned `undefined`, so `ctx.error.issues[n]` has
  // exactly zod's key set — zod's `finalizeIssue` deletes it, and the key's
  // presence shows through `Object.keys`/spread/strict deep-equal even when the
  // value reads as `undefined` either way. (`ctx.issues` is a documented
  // divergence: zod hands the callback the RAW payload array there, carrying
  // `inst` — the schema instance — which compiled code has no counterpart for.
  // See tests/known-divergences.test.ts.) Only reached on an inner failure, and
  // that failure is about to be swallowed by the catch value, so nothing on a
  // successful parse pays for the delete.
  return [
    `var ${tempIssues}=[];var ${inVar}=${g.input};`,
    g.visit(ir.inner, { issues: tempIssues }),
    `if(${tempIssues}.length>0){`,
    `for(var ${idxVar}=0;${idxVar}<${tempIssues}.length;${idxVar}++){`,
    `if(${tempIssues}[${idxVar}].message===undefined&&typeof __zcMsg==="function"){${tempIssues}[${idxVar}].message=__zcMsg(${tempIssues}[${idxVar}]);}`,
    `delete ${tempIssues}[${idxVar}].input;`,
    `}`,
    `var ${cvVar}=__rf[${ir.refIndex}]._zod.def.catchValue;`,
    `${g.output}=typeof ${cvVar}==="function"?${cvVar}({value:${inVar},issues:${tempIssues},error:{issues:${tempIssues}},input:${inVar}}):${cvVar};`,
    `}`,
    "",
  ].join("\n");
}

export function fastCatch(ir: CatchIR, g: FastGen): string | null {
  return g.visit(ir.inner);
}
