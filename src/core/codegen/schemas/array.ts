import type { ArrayIR, CheckIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import {
  checkPriority,
  declareFastTemps,
  emitRuntimeHelper,
  extendPath,
  hasMutation,
  visitMember,
} from "../context.js";
import { emit } from "../emit.js";
import { invalidType, tooBig, tooSmall } from "../emit-issue.js";
import { ZC_AB_DECL } from "../issue-decls.js";
import { fastRefineTest, refineCheck, superRefineCheck, superRefineFastTest } from "./effect.js";
import { whenGatedSizeChecks } from "./sizeable.js";

export function slowArray(ir: SchemaIR & { type: "array" }, g: SlowGen): string {
  let code = emit`
    if(!Array.isArray(${g.input})){
      ${invalidType(g, "array")}
      ${whenGatedSizeChecks(ir.checks, g, "length", true)}
    }else{`;

  // Every element is read and written through ONE binding, handed back as the
  // output after the loop — slowTuple's discipline, for slowTuple's reason: a
  // parent can hand this node `g.input` and `g.output` as two different
  // bindings, and copying into `g.output` while the elements went on being
  // written through `g.input` returned the ORIGINAL elements and rewrote the
  // caller's array. A mutating element schema rewrites values as a matter of
  // course, so its copy is taken up front; anything else copies only once an
  // element hands back a replacement (see visitMember).
  const arr = g.temp("ar");
  code += `var ${arr}=${g.input};`;
  if (hasMutation(ir.element)) {
    code += `${arr}=${arr}.slice();`;
  }

  // Element validation precedes the size/refine checks: Zod parses elements
  // (the base type) first and only then runs its checks, so for an input that
  // both has an invalid element AND fails a size check, the per-element issue
  // is surfaced before too_small/too_big. Emitting the checks first would
  // reverse that order (the slow path collects all issues with no
  // short-circuit, so insertion order IS issue order).

  // Snapshot before the elements, for the same reason slowObject does: the
  // array's refine effects are gated on zod's abort rule over the issues THIS
  // node's parse produced. Size checks are exempt — zod's length checks declare
  // a `when` predicate, which bypasses the abort gate, so
  // `z.array(z.string()).min(2)` still reports too_small next to a bad element's
  // invalid_type.
  const hasRefine = ir.checks.some(
    (c) => c.kind === "refine_effect" || c.kind === "super_refine_effect",
  );
  const refineMark = hasRefine ? g.temp("rm") : "";
  if (refineMark) code += `var ${refineMark}=${g.issues}.length;`;

  const idxVar = g.temp("i");
  const element = visitMember(g, ir.element, {
    container: arr,
    original: g.input,
    copy: `${arr}.slice()`,
    key: idxVar,
    path: extendPath(g.path, idxVar),
    issues: g.issues,
  });
  code += emit`
    for(var ${idxVar}=0;${idxVar}<${arr}.length;${idxVar}++){
      ${element}
    }
    ${g.output}=${arr};`;

  /** Wrap one refine effect in zod's abort gate, preserving declaration order. */
  const gated = (body: string): string => {
    const aborted = emitRuntimeHelper(g.ctx, "__zcAb", ZC_AB_DECL);
    return `if(!${aborted}(${g.issues},${refineMark})){${body}}`;
  };

  // The checks run on the parsed array, as zod's run on `payload.value`: the
  // output, which carries any replacement an element handed back, and is what
  // a superRefine rewrites for the checks after it.
  const parsed = g.output;
  for (const check of ir.checks) {
    switch (check.kind) {
      case "min_length":
        code += emit`
          if(${parsed}.length<${check.minimum}){
            ${tooSmall(g, check.minimum, "array", true, { message: check.message })}
          }`;
        break;
      case "max_length":
        code += emit`
          if(${parsed}.length>${check.maximum}){
            ${tooBig(g, check.maximum, "array", true, { message: check.message })}
          }`;
        break;
      case "length_equals":
        code += emit`
          if(${parsed}.length<${check.length}){
            ${tooSmall(g, check.length, "array", true, { exact: true, message: check.message })}
          }else if(${parsed}.length>${check.length}){
            ${tooBig(g, check.length, "array", true, { exact: true, message: check.message })}
          }`;
        break;
      case "refine_effect":
        code += gated(refineCheck(check, parsed, g));
        break;
      case "super_refine_effect":
        code += gated(superRefineCheck(check, parsed, g));
        break;
    }
  }

  code += `}`;
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

  // Element validation via preamble helper (avoids .every() closure allocation).
  // Fresh scope: the helper is its own function, size-gated independently.
  const elemVar = g.temp("ae");
  const elemGen = g.scoped(elemVar);
  const elemCheck = elemGen.visit(ir.element);
  if (elemCheck === null) return null;
  if (elemCheck !== "true") {
    const helperName = g.temp("af");
    g.ctx.preamble.push(
      `function ${helperName}(a){${declareFastTemps(elemGen.scope)}for(var ${elemVar},i=0;i<a.length;i++){${elemVar}=a[i];if(!(${elemCheck})){return false;}}return true;}`,
    );
    parts.push(`${helperName}(${x})`);
  }

  // Refine effect checks (appended last — run after cheap checks short-circuit)
  for (const check of ir.checks) {
    if (check.kind === "refine_effect") {
      parts.push(fastRefineTest(check, x, g));
    } else if (check.kind === "super_refine_effect") {
      parts.push(superRefineFastTest(check, x, g));
    }
  }

  return parts.join("&&");
}
