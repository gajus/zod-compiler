import type { SchemaIR, SetIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { checkPriority, extendPath, hasMutation } from "../context.js";
import { emit } from "../emit.js";
import { invalidType, tooBig, tooSmall } from "../emit-issue.js";

export function slowSet(ir: SchemaIR & { type: "set" }, g: SlowGen): string {
  let code = emit`
    if(!(${g.input} instanceof Set)){
      ${invalidType(g, "set")}
    }else{`;

  // Validate each element BEFORE the size checks: Zod parses the elements
  // first and runs size checks afterward, so an invalid element surfaces ahead
  // of too_small/too_big when both fail. Mutating element schemas (coerce,
  // .trim(), url) rewrite the loop variable, which a Set cannot reflect —
  // rebuild into a fresh Set so the mutated values land in the output.
  const mutates = hasMutation(ir.valueType);
  const iterVar = g.temp("set_v");
  const idxVar = g.temp("set_i");
  const rebuiltVar = mutates ? g.temp("set_n") : "";
  if (mutates) {
    code += `var ${rebuiltVar}=new Set();`;
  }
  code += emit`
    var ${idxVar}=0;
    for(var ${iterVar} of ${g.input}){
      ${g.visit(ir.valueType, { input: iterVar, output: iterVar, path: extendPath(g.path, idxVar) })}
      ${mutates ? `${rebuiltVar}.add(${iterVar});` : ""}
      ${idxVar}++;
    }
    ${mutates ? `${g.output}=${rebuiltVar};` : ""}`;

  // Size checks (run after element validation, mirroring Zod's check order).
  if (ir.checks) {
    for (const check of ir.checks) {
      switch (check.kind) {
        case "min_size":
          code += emit`
            if(${g.input}.size<${check.minimum}){
              ${tooSmall(g, check.minimum, "set", true, { message: check.message })}
            }`;
          break;
        case "max_size":
          code += emit`
            if(${g.input}.size>${check.maximum}){
              ${tooBig(g, check.maximum, "set", true, { message: check.message })}
            }`;
          break;
        case "size_equals":
          code += emit`
            if(${g.input}.size<${check.size}){
              ${tooSmall(g, check.size, "set", true, { exact: true, message: check.message })}
            }else if(${g.input}.size>${check.size}){
              ${tooBig(g, check.size, "set", true, { exact: true, message: check.message })}
            }`;
          break;
      }
    }
  }

  code += `}`;
  return `${code}\n`;
}

export function fastSet(ir: SetIR, g: FastGen): string | null {
  const x = g.input;
  const parts: string[] = [`${x} instanceof Set`];

  // Size checks
  if (ir.checks) {
    for (const check of [...ir.checks].sort(checkPriority)) {
      switch (check.kind) {
        case "min_size":
          parts.push(`${x}.size>=${check.minimum}`);
          break;
        case "max_size":
          parts.push(`${x}.size<=${check.maximum}`);
          break;
        case "size_equals":
          parts.push(`${x}.size===${check.size}`);
          break;
      }
    }
  }

  // Element validation via preamble helper (Set has no .every()).
  // Fresh scope: the helper is its own function, size-gated independently.
  const elemVar = g.temp("sv");
  const elemCheck = g.scoped(elemVar).visit(ir.valueType);
  if (elemCheck === null) return null;
  if (elemCheck !== "true") {
    const helperName = g.temp("se");
    g.ctx.preamble.push(
      `function ${helperName}(s){for(var ${elemVar} of s){if(!(${elemCheck})){return false;}}return true;}`,
    );
    parts.push(`${helperName}(${x})`);
  }

  return parts.join("&&");
}
