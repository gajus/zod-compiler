import type { FallbackIR } from "../../types.js";
import type { SlowGen } from "../context.js";
import { emitRfZod, emitRuntimeHelper } from "../context.js";
import { emit } from "../emit.js";
import { ZC_DELEGATE_ISSUES_DECL, ZC_RUN_DELEGATE_DECL } from "../issue-decls.js";

export function slowFallback(ir: FallbackIR, g: SlowGen): string {
  if (ir.refIndex !== undefined) {
    return slowZodDelegate(ir.refIndex, g);
  }
  return `${g.issues}.push({code:"custom",path:${g.path},message:"Fallback schema: ${ir.reason}"});\n`;
}

/**
 * Delegate a cold slow-walk leaf to a pristine retained Zod schema.
 *
 * The schema is run through `_zod.run` and its RAW payload read, not through
 * `safeParse`: the payload is where zod's per-issue `continue` flags and the
 * `aborted` bit still exist, and a plain union prunes its options on exactly
 * those (see ZC_RUN_DELEGATE_DECL). The issues are then finalized by zod's own
 * `finalizeIssue` and re-homed under this node's path (ZC_DELEGATE_ISSUES_DECL),
 * so what lands in the validator's list is what `safeParse` would have built,
 * plus a `continue:false` marker on each aborting issue that the top-level
 * finalizer strips again. The per-call `{async:false}` ctx is the one zod's
 * `_safeParse` allocates, handed to both `run` and `finalizeIssue` as zod does.
 *
 * `payload.aborted` — set by a pipe whose `in` failed — is forwarded only when
 * this delegate IS a union option (`g.aborted` bound). Nested deeper it is
 * dropped, as zod's `handlePropertyResult` drops it: only the issues travel up.
 */
export function slowZodDelegate(refIndex: number, g: SlowGen, onFailure = ""): string {
  const zod = emitRfZod(g.ctx, refIndex);
  const run = emitRuntimeHelper(g.ctx, "__zcRd", ZC_RUN_DELEGATE_DECL);
  const finalize = emitRuntimeHelper(g.ctx, "__zcRf", ZC_DELEGATE_ISSUES_DECL);
  const cVar = `__rf_c${refIndex}`;
  const rVar = `__rf_r${refIndex}`;
  const abort = g.aborted === undefined ? "" : `if(${rVar}.aborted===true){${g.aborted}=true;}`;
  return `${emit`
    var ${cVar}={async:false};
    var ${rVar}=${run}(${zod},${g.input},${cVar});
    if(${rVar}.issues.length){
      ${onFailure}
      ${finalize}(${rVar}.issues,${cVar},${g.issues},${g.path});
      ${abort}
    }else{
      ${g.output}=${rVar}.value;
    }
  `}\n`;
}
