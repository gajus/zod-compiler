import type { RecursionTargetIR, RecursiveRefIR } from "../../types.js";
import type { CodeGenContext, FastGen, SlowGen } from "../context.js";
import { emit } from "../emit.js";

/**
 * Resolve the slow (safeParse-shaped) validator name for a recursion target.
 * refId 0 / no table ⇒ the root, which is the schema's own `safeParse_<name>`.
 */
function slowTargetName(ctx: CodeGenContext, refId: number | undefined): string {
  const t = ctx.recTargets?.get(refId ?? 0);
  return t && !t.isRoot ? t.slowName : ctx.fnName;
}

/**
 * Emit a recursion call on the slow (issue-collecting) path: invoke the hosted
 * validator for the target shape, then either merge its issues with the current
 * path prefix or write back its (possibly mutated) data. Shared by both the
 * back-edge (`recursiveRef`) and the in-place target site (`recursionTarget`).
 */
function slowRecursionCall(refId: number | undefined, g: SlowGen): string {
  const fn = slowTargetName(g.ctx, refId);
  const n = g.ctx.counter++;
  const rVar = `__rec_r${n}`;
  const iVar = `__rec_i${n}`;
  const jVar = `__rec_j${n}`;
  return `${emit`
    var ${rVar}=${fn}(${g.input});
    if(!${rVar}.success){
      var ${iVar}=${rVar}.error.issues;
      for(var ${jVar}=0;${jVar}<${iVar}.length;${jVar}++){
        ${g.issues}.push({...${iVar}[${jVar}],
          path:${g.path}.concat(${iVar}[${jVar}].path)});
      }
    }else{
      ${g.output}=${rVar}.data;
    }
  `}\n`;
}

/**
 * Resolve the fast (boolean) validator name for a recursion target, allocating
 * the root's lazily (mirrors the historical single-target behavior). Returns a
 * call expression on the target's hosted fast-check.
 */
function fastRecursionCall(refId: number | undefined, g: FastGen): string {
  const ctx = g.ctx;
  const t = ctx.recTargets?.get(refId ?? 0);
  if (!t || t.isRoot) {
    // Root recursion (refId 0, or a standalone generator call with no table):
    // the root fast expression is hosted under this name by generateValidator.
    ctx.recFastName ??= `__fcr_${ctx.counter++}`;
    if (t) t.fastName = ctx.recFastName;
    return `${ctx.recFastName}(${g.input})`;
  }
  // Non-root target: name pre-allocated by generateValidator before the walk.
  return `${t.fastName}(${g.input})`;
}

export function slowRecursiveRef(ir: RecursiveRefIR, g: SlowGen): string {
  return slowRecursionCall(ir.refId, g);
}

export function fastRecursiveRef(ir: RecursiveRefIR, g: FastGen): string | null {
  return fastRecursionCall(ir.refId, g);
}

/**
 * In-place site of a non-root recursion target (the recursive sub-schema where
 * it sits in the larger tree). Validating it = calling its hosted validator,
 * exactly like a back-edge, so both reuse the recursion-call emitters.
 */
export function slowRecursionTarget(ir: RecursionTargetIR, g: SlowGen): string {
  return slowRecursionCall(ir.refId, g);
}

export function fastRecursionTarget(ir: RecursionTargetIR, g: FastGen): string | null {
  return fastRecursionCall(ir.refId, g);
}
