import type { RefineEffectCheckIR, TransformEffectIR } from "../../types.js";
import type { SlowGen } from "../context.js";
import { emitEffectFn } from "../context.js";
import { emit } from "../emit.js";

/**
 * Generate code for a TransformEffectIR node.
 * Validates the inner schema, then applies the transform function and writes back the result.
 */
export function slowEffect(ir: TransformEffectIR, g: SlowGen): string {
  const beforeVar = g.temp("ib");
  const innerCode = g.visit(ir.inner);
  // A transform is `inner.transform(fn)` = a pipe(inner, transform): zod's
  // handlePipeResult aborts when `inner` produces any issue. Inside a union the
  // option must therefore count as aborted even if `inner`'s only issue is a
  // non-aborting `custom`/check-level code (mirrors slowPipe's abort branch).
  const abortBranch = g.aborted ? `else{${g.aborted}=true;}` : "";

  return `${emit`
    var ${beforeVar}=${g.issues}.length;
    ${innerCode}
    if(${g.issues}.length===${beforeVar}){
      ${g.output}=${emitEffectFn(g.ctx, ir.source)}(${g.output});
    }${abortBranch}
  `}\n`;
}

/**
 * Generate code for a RefineEffectCheckIR (inline refine function call).
 * Called from string/number/object check loops when a refine_effect is encountered.
 *
 * @param check - The refine effect check IR
 * @param expr - The expression to validate (may differ from g.input, e.g. objVar in object generators)
 * @param g - SlowGen context (provides path, issues)
 */
export function refineCheck(check: RefineEffectCheckIR, expr: string, g: SlowGen): string {
  // Custom issues are created by the refine check instance, so only the
  // refine's own message applies (never the schema-level error). With no
  // message baked in, __zcFin applies the locale default ("Invalid input").
  const messageProp =
    check.message === undefined ? "" : `,message:${JSON.stringify(check.message)}`;
  return emit`
    if(!${emitEffectFn(g.ctx, check.source)}(${expr})){
      ${g.issues}.push({code:"custom",path:${g.path}${messageProp},input:${expr}});
    }`;
}
