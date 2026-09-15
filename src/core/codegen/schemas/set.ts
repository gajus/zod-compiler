import type { SchemaIR, SetIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { checkPriority, declareFastTemps, hasMutation } from "../context.js";
import { emit } from "../emit.js";
import { invalidType, tooBig, tooSmall } from "../emit-issue.js";
import { whenGatedSizeChecks } from "./sizeable.js";

export function slowSet(ir: SchemaIR & { type: "set" }, g: SlowGen): string {
  let code = emit`
    if(!(${g.input} instanceof Set)){
      ${invalidType(g, "set")}
      ${whenGatedSizeChecks(ir.checks ?? [], g, "size")}
    }else{`;

  // Validate each element BEFORE the size checks: Zod parses the elements
  // first and runs size checks afterward, so an invalid element surfaces ahead
  // of too_small/too_big when both fail. Mutating element schemas (coerce,
  // .trim(), url) rewrite the loop variable, which a Set cannot reflect —
  // rebuild into a fresh Set so the mutated values land in the output.
  const iterVar = g.temp("set_v");
  // The element's path is the SET's own path, with no index segment: a Set has
  // no stable positional addressing, so zod's handleSetResult pushes each
  // element's issues into the set's payload UNPREFIXED (unlike an array, whose
  // handleArrayResult prefixes the index). Two bad elements therefore report at
  // the same path — that is zod's output, and an index we invented instead made
  // every set-element issue point somewhere zod never points.
  if (hasMutation(ir.valueType)) {
    const rebuiltVar = g.temp("set_n");
    code += emit`
      var ${rebuiltVar}=new Set();
      for(var ${iterVar} of ${g.input}){
        ${g.visit(ir.valueType, { input: iterVar, output: iterVar, path: g.path })}
        ${rebuiltVar}.add(${iterVar});
      }
      ${g.output}=${rebuiltVar};`;
  } else {
    // An element that rewrites nothing can still hand back a REPLACEMENT — a
    // `__proto__`-scrubbed copy, a recursive element rebuilt by its own
    // validator — which zod's output Set holds in that element's place. Visited
    // with an output local of its own (see visitMember), the first replacement
    // starts the rebuilt Set: the elements before it, in order, then every
    // element's output from there on. A Set nothing replaces still comes back
    // by reference, and an element that never names its output costs nothing.
    const outVar = g.temp("set_o");
    const element = g.visit(ir.valueType, { input: iterVar, output: outVar, path: g.path });
    if (!element.includes(outVar)) {
      code += emit`
        for(var ${iterVar} of ${g.input}){
          ${element}
        }`;
    } else {
      const rebuiltVar = g.temp("set_n");
      const countVar = g.temp("set_c");
      const skipVar = g.temp("set_j");
      const earlierVar = g.temp("set_p");
      code += emit`
        var ${rebuiltVar}=null;
        var ${countVar}=0;
        for(var ${iterVar} of ${g.input}){
          var ${outVar}=${iterVar};
          ${element}
          if(${rebuiltVar}!==null){
            ${rebuiltVar}.add(${outVar});
          }else if(${outVar}!==${iterVar}){
            ${rebuiltVar}=new Set();
            var ${skipVar}=0;
            for(var ${earlierVar} of ${g.input}){
              if(${skipVar}++===${countVar})break;
              ${rebuiltVar}.add(${earlierVar});
            }
            ${rebuiltVar}.add(${outVar});
          }
          ${countVar}++;
        }
        if(${rebuiltVar}!==null){${g.output}=${rebuiltVar};}`;
    }
  }

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
  const elemGen = g.scoped(elemVar);
  const elemCheck = elemGen.visit(ir.valueType);
  if (elemCheck === null) return null;
  if (elemCheck !== "true") {
    const helperName = g.temp("se");
    g.ctx.preamble.push(
      `function ${helperName}(s){${declareFastTemps(elemGen.scope)}for(var ${elemVar} of s){if(!(${elemCheck})){return false;}}return true;}`,
    );
    parts.push(`${helperName}(${x})`);
  }

  return parts.join("&&");
}
