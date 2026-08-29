import type { SchemaIR, TupleIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import {
  declareFastTemps,
  extendPath,
  extendStaticPathIndex,
  hasMutation,
  tuplePadsShortInput,
} from "../context.js";
import { orderByRuntimeCost } from "../fast-size.js";
import { emit } from "../emit.js";
import { invalidType, tooBig, tooSmall } from "../emit-issue.js";

/**
 * Mirrors $ZodTuple: without rest, over-length input emits a single too_big
 * and `length < optStart - 1` a single too_small (minimum = items.length) —
 * both created by the tuple node (schema error applies) and both skip item
 * validation. Anything else validates items; missing required items read as
 * undefined and fail their item schema's type check at the right path.
 *
 * The two halves of zod's ternary are NOT symmetric about `inclusive`:
 * `tooBig ? { code: "too_big", maximum: items.length, inclusive: true } :
 * { code: "too_small", minimum: items.length }`. The under-length issue has no
 * `inclusive` key at all, so it is emitted with `"omit"` rather than `false` —
 * which would be an invented field. The locale phrases it ">N items" off the
 * key's absence, which is why the message matched even while the shape did not.
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

  // Pad a short input up to `optStart`. zod runs every item below that index
  // whatever the input's length and writes each result back
  // (`final.value[i] = result.value`), so a required slot past the end lands as
  // an own `undefined` and the output array is LONGER than the input — visible
  // only when that item accepts undefined, which is what tuplePadsShortInput
  // tests (`z.tuple([z.any(), z.any()]).parse(["x"])` is `["x", undefined]`).
  // Guarded on the length, so a well-formed input never allocates: this runs
  // only where the item loop is about to read past the end anyway.
  if (tuplePadsShortInput(ir)) {
    const padVar = g.temp("tp");
    itemsCode += emit`
      if(${g.input}.length<${ir.optStart}){
        ${g.output}=${g.input}.slice();
        for(var ${padVar}=${g.input}.length;${padVar}<${ir.optStart};${padVar}++){
          ${g.input}[${padVar}]=undefined;
        }
      }`;
  }

  for (let i = 0; i < len; i++) {
    const itemIR = ir.items[i] as SchemaIR;
    const elemExpr = `${g.input}[${i}]`;
    const elemPath = extendStaticPathIndex(g.path, i);
    const skipMissingOptional = i >= ir.optStart;
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
    const start = ir.optStart;
    code += emit`
      if(${g.input}.length>${len}){
        ${tooBig(g, len, "array", true, { layout: "tuple", aborts: true })}
      }else if(${g.input}.length<${start - 1}){
        ${tooSmall(g, len, "array", "omit", { aborts: true })}
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

  const required = ir.optStart;
  if (ir.rest === null) {
    if (required === ir.items.length) {
      parts.push(`${x}.length===${ir.items.length}`);
    } else {
      parts.push(`${x}.length>=${required}`, `${x}.length<=${ir.items.length}`);
    }
  } else if (required > 0) {
    parts.push(`${x}.length>=${required}`);
  }

  // Per-index checks, cheapest-first: positions are independent, so the emitted
  // order only decides which one a reject stops on (see estimateRuntimeCost).
  // The Array.isArray + length conjuncts above stay in front — the element
  // reads are only meaningful once they hold.
  const indexed = ir.items.flatMap((itemIR, index) => (itemIR ? [{ index, itemIR }] : []));
  for (const { index, itemIR } of orderByRuntimeCost(indexed, (e) => e.itemIR, g.ctx)) {
    const itemCheck = g.visit(itemIR, { input: `${x}[${index}]` });
    if (itemCheck === null) return null;
    if (itemCheck === "true") continue;
    // An item in the omittable tail is not merely allowed to be `undefined` —
    // zod does not run its schema AT ALL when the input is that short
    // (`if (i >= input.length) if (i >= optStart) continue`). Reading `x[i]` and
    // testing it would demand that the item's own check accept `undefined`,
    // which the fast forms of `z.undefined()` and `.optional()` happen to do but
    // a pipe or a union arm need not — so gate on presence the way zod does.
    parts.push(index >= ir.optStart ? `(${x}.length<=${index}||${itemCheck})` : itemCheck);
  }

  // Rest element validation via preamble helper (avoids .slice().every()
  // allocation). Fresh scope: the helper is its own function, size-gated
  // independently. (Fixed items above stay inline in the caller's && chain.)
  if (ir.rest !== null) {
    const rv = g.temp("tr");
    const restGen = g.scoped(rv);
    const restCheck = restGen.visit(ir.rest);
    if (restCheck === null) return null;
    if (restCheck !== "true") {
      const helperName = g.temp("te");
      g.ctx.preamble.push(
        `function ${helperName}(a,s){${declareFastTemps(restGen.scope)}for(var ${rv},i=s;i<a.length;i++){${rv}=a[i];if(!(${restCheck})){return false;}}return true;}`,
      );
      parts.push(`${helperName}(${x},${ir.items.length})`);
    }
  }

  return parts.join("&&");
}
