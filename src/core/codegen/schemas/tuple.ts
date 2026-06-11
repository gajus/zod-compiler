import type { SchemaIR, TupleIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { extendPath, extendStaticPathIndex, hasMutation } from "../context.js";
import { emit } from "../emit.js";
import { invalidType, tooBig, tooSmall } from "../emit-issue.js";

/**
 * Index where the omittable tail begins (zod's `optStart`): trailing
 * optional/default items have `optin === "optional"` and may be absent.
 */
function optStart(ir: TupleIR): number {
  let start = ir.items.length;
  for (let i = ir.items.length - 1; i >= 0; i--) {
    const itemType = (ir.items[i] as SchemaIR).type;
    if (itemType !== "optional" && itemType !== "default") break;
    start--;
  }
  return start;
}

/**
 * Mirrors $ZodTuple: without rest, over-length input emits a single too_big
 * and `length < optStart - 1` a single too_small (minimum = items.length,
 * non-inclusive phrasing) — both created by the tuple node (schema error
 * applies) and both skip item validation. Anything else validates items;
 * missing required items read as undefined and fail their item schema's type
 * check at the right path.
 */
export function slowTuple(ir: SchemaIR & { type: "tuple" }, g: SlowGen): string {
  const len = ir.items.length;

  let code = emit`
    if(!Array.isArray(${g.input})){
      ${invalidType(g, "tuple")}
    }else{`;

  let itemsCode = "";
  if (ir.items.some(hasMutation) || (ir.rest !== null && hasMutation(ir.rest))) {
    itemsCode += `${g.output}=${g.input}.slice();`;
  }

  for (let i = 0; i < len; i++) {
    const itemIR = ir.items[i] as SchemaIR;
    const elemExpr = `${g.input}[${i}]`;
    const elemPath = extendStaticPathIndex(g.path, i);
    const skipMissingOptional = i >= optStart(ir);
    const itemCode = g.visit(itemIR, { input: elemExpr, output: elemExpr, path: elemPath });
    // Zod skips absent omittable items entirely (no default materialization).
    itemsCode += skipMissingOptional ? emit`if(${i}<${g.input}.length){${itemCode}}` : itemCode;
  }

  if (ir.rest !== null) {
    const idxVar = g.temp("ti");
    const restExpr = `${g.input}[${idxVar}]`;
    const restPath = extendPath(g.path, idxVar);
    itemsCode += emit`
      for(var ${idxVar}=${len};${idxVar}<${g.input}.length;${idxVar}++){
        ${g.visit(ir.rest, { input: restExpr, output: restExpr, path: restPath })}
      }`;
  }

  if (ir.rest === null) {
    const start = optStart(ir);
    code += emit`
      if(${g.input}.length>${len}){
        ${tooBig(g, len, "array", true, { useTypeMsg: true })}
      }else if(${g.input}.length<${start - 1}){
        ${tooSmall(g, len, "array", false, { useTypeMsg: true })}
      }else{
        ${itemsCode}
      }`;
  } else {
    code += itemsCode;
  }

  code += `}\n`;
  return code;
}

export function fastTuple(ir: TupleIR, g: FastGen): string | null {
  const x = g.input;
  const parts: string[] = [`Array.isArray(${x})`];

  const required = optStart(ir);
  if (ir.rest === null) {
    if (required === ir.items.length) {
      parts.push(`${x}.length===${ir.items.length}`);
    } else {
      parts.push(`${x}.length>=${required}`, `${x}.length<=${ir.items.length}`);
    }
  } else if (required > 0) {
    parts.push(`${x}.length>=${required}`);
  }

  // Per-index checks
  for (let i = 0; i < ir.items.length; i++) {
    const itemIR = ir.items[i];
    if (!itemIR) continue;
    const itemCheck = g.visit(itemIR, { input: `${x}[${i}]` });
    if (itemCheck === null) return null;
    if (itemCheck !== "true") parts.push(itemCheck);
  }

  // Rest element validation via preamble helper (avoids .slice().every() allocation)
  if (ir.rest !== null) {
    const rv = g.temp("tr");
    const restCheck = g.visit(ir.rest, { input: rv });
    if (restCheck === null) return null;
    if (restCheck !== "true") {
      const helperName = g.temp("te");
      g.ctx.preamble.push(
        `function ${helperName}(a,s){for(var ${rv},i=s;i<a.length;i++){${rv}=a[i];if(!(${restCheck})){return false;}}return true;}`,
      );
      parts.push(`${helperName}(${x},${ir.items.length})`);
    }
  }

  return parts.join("&&");
}
