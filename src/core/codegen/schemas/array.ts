import type { ArrayIR, CheckIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { checkPriority, emitEffectFn, extendPath, hasMutation } from "../context.js";
import { emit } from "../emit.js";
import { invalidType, tooBig, tooSmall } from "../emit-issue.js";
import { refineCheck } from "./effect.js";

export function slowArray(ir: SchemaIR & { type: "array" }, g: SlowGen): string {
  let code = emit`
    if(!Array.isArray(${g.input})){
      ${invalidType(g, "array")}
    }else{`;

  if (hasMutation(ir.element)) {
    code += `${g.output}=${g.input}.slice();`;
  }

  for (const check of ir.checks) {
    switch (check.kind) {
      case "min_length":
        code += emit`
          if(${g.input}.length<${check.minimum}){
            ${tooSmall(g, check.minimum, "array", true, { message: check.message })}
          }`;
        break;
      case "max_length":
        code += emit`
          if(${g.input}.length>${check.maximum}){
            ${tooBig(g, check.maximum, "array", true, { message: check.message })}
          }`;
        break;
      case "length_equals":
        code += emit`
          if(${g.input}.length<${check.length}){
            ${tooSmall(g, check.length, "array", true, { exact: true, message: check.message })}
          }else if(${g.input}.length>${check.length}){
            ${tooBig(g, check.length, "array", true, { exact: true, message: check.message })}
          }`;
        break;
      case "refine_effect":
        code += refineCheck(check, g.input, g);
        break;
    }
  }

  const idxVar = g.temp("i");
  const elemExpr = `${g.input}[${idxVar}]`;
  const elemPath = extendPath(g.path, idxVar);
  code += emit`
    for(var ${idxVar}=0;${idxVar}<${g.input}.length;${idxVar}++){
      ${g.visit(ir.element, { input: elemExpr, output: elemExpr, path: elemPath })}
    }
  }`;
  return `${code}\n`;
}

export function fastArray(ir: ArrayIR, g: FastGen): string | null {
  const x = g.input;
  const parts: string[] = [`Array.isArray(${x})`];
  const checks = ir.checks.filter((c): c is CheckIR => c.kind !== "refine_effect");

  // Size checks
  for (const check of checks.sort(checkPriority)) {
    switch (check.kind) {
      case "min_length":
        parts.push(`${x}.length>=${check.minimum}`);
        break;
      case "max_length":
        parts.push(`${x}.length<=${check.maximum}`);
        break;
      case "length_equals":
        parts.push(`${x}.length===${check.length}`);
        break;
    }
  }

  // Element validation via preamble helper (avoids .every() closure allocation)
  const elemVar = g.temp("ae");
  const elemCheck = g.visit(ir.element, { input: elemVar });
  if (elemCheck === null) return null;
  if (elemCheck !== "true") {
    const helperName = g.temp("af");
    g.ctx.preamble.push(
      `function ${helperName}(a){for(var ${elemVar},i=0;i<a.length;i++){${elemVar}=a[i];if(!(${elemCheck})){return false;}}return true;}`,
    );
    parts.push(`${helperName}(${x})`);
  }

  // Refine effect checks (appended last — run after cheap checks short-circuit)
  for (const check of ir.checks) {
    if (check.kind === "refine_effect") {
      parts.push(`${emitEffectFn(g.ctx, check.source)}(${x})`);
    }
  }

  return parts.join("&&");
}
