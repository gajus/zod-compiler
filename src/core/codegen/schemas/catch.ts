import type { CatchIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";

export function slowCatch(ir: SchemaIR & { type: "catch" }, g: SlowGen): string {
  const tempIssues = g.temp("ci");
  const idxVar = g.temp("ck");
  const cvVar = g.temp("cv");
  // Mirrors $ZodCatch: on inner failure, catchValue receives a ctx of
  // { value, issues, error: { issues }, input } and its result replaces the
  // value; the issues are swallowed. Finalize messages first so ctx readers
  // see zod-shaped issues (one finalized array serves both fields).
  return [
    `var ${tempIssues}=[];`,
    g.visit(ir.inner, { issues: tempIssues }),
    `if(${tempIssues}.length>0){`,
    `for(var ${idxVar}=0;${idxVar}<${tempIssues}.length;${idxVar}++){`,
    `if(${tempIssues}[${idxVar}].message===undefined&&typeof __zcMsg==="function"){${tempIssues}[${idxVar}].message=__zcMsg(${tempIssues}[${idxVar}]);}`,
    `${tempIssues}[${idxVar}].input=undefined;`,
    `}`,
    `var ${cvVar}=__rf[${ir.refIndex}]._zod.def.catchValue;`,
    `${g.output}=typeof ${cvVar}==="function"?${cvVar}({value:${g.input},issues:${tempIssues},error:{issues:${tempIssues}},input:${g.input}}):${cvVar};`,
    `}`,
    "",
  ].join("\n");
}

export function fastCatch(ir: CatchIR, g: FastGen): string | null {
  return g.visit(ir.inner);
}
