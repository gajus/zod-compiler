import type { ObjectIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import {
  ENUM_INLINE_THRESHOLD,
  emitEffectFn,
  emitSet,
  escapeString,
  extendStaticPath,
  hasMutation,
} from "../context.js";
import { emit } from "../emit.js";
import { invalidType, unrecognizedKeys } from "../emit-issue.js";
import { refineCheck } from "./effect.js";

/**
 * Boolean membership test for one key variable against the shape's key set.
 * Small shapes inline `===` chains (the enum-inlining result applies — string
 * internalization makes repeat comparisons pointer-equality); larger shapes
 * share a preamble Set. An empty shape recognizes nothing ("false").
 */
function keyMembershipTest(
  keys: readonly string[],
  keyVar: string,
  emitKeySet: () => string,
): string {
  if (keys.length === 0) return "false";
  if (keys.length <= ENUM_INLINE_THRESHOLD) {
    return keys.map((k) => `${keyVar}===${escapeString(k)}`).join("||");
  }
  return `${emitKeySet()}.has(${keyVar})`;
}

export function slowObject(ir: SchemaIR & { type: "object" }, g: SlowGen): string {
  let code = emit`
    if(typeof ${g.input}!=="object"||${g.input}===null||Array.isArray(${g.input})){
      ${invalidType(g, "object")}
    }else{`;

  const needsClone = Object.values(ir.properties).some(hasMutation);
  const objVar = g.temp("o");
  // Spread, not Object.assign: V8's CloneObjectIC makes `{...x}` ~25% faster
  // on the whole safeParse call for mutation-bearing schemas.
  code += needsClone ? `var ${objVar}={...${g.input}};` : `var ${objVar}=${g.input};`;

  const suppressAbsent = new Set(ir.suppressAbsentKeys ?? []);
  for (const [key, propIR] of Object.entries(ir.properties)) {
    const propExpr = `${objVar}[${escapeString(key)}]`;
    const propPath = extendStaticPath(g.path, key);
    const propCode = g.visit(propIR, { input: propExpr, output: propExpr, path: propPath });
    if (suppressAbsent.has(key)) {
      // Mirrors zod's handlePropertyResult: optional-out fallback props run,
      // but their issues are discarded when the key is absent from the input.
      const beforeVar = g.temp("ob");
      code += emit`
        var ${beforeVar}=${g.issues}.length;
        ${propCode}
        if(!(${escapeString(key)} in ${objVar})&&${g.issues}.length>${beforeVar}){
          ${g.issues}.length=${beforeVar};
        }`;
    } else {
      code += propCode;
    }
  }

  // Strict unknown-key pass — zod's handleCatchall, byte-exact: for-in over
  // the ORIGINAL input (inherited enumerable keys count, no hasOwnProperty),
  // ALL unknown keys collected into one issue, pushed AFTER property issues
  // and before object-level refines.
  if (ir.strict) {
    const keys = Object.keys(ir.properties);
    const ukVar = g.temp("uk");
    const kVar = g.temp("k");
    const test = keyMembershipTest(keys, kVar, () => g.set("ks", keys));
    code += emit`
      var ${ukVar}=null;
      for(var ${kVar} in ${g.input}){
        if(!(${test})){(${ukVar}=${ukVar}||[]).push(${kVar});}
      }
      if(${ukVar}!==null){
        ${unrecognizedKeys(g, ukVar)}
      }`;
  }

  if (needsClone) {
    code += `${g.output}=${objVar};`;
  }

  // Object-level refine effects: z.object({...}).refine(fn)
  if (ir.checks) {
    for (const check of ir.checks) {
      code += refineCheck(check, objVar, g);
    }
  }

  code += `}\n`;
  return code;
}

export function fastObject(ir: ObjectIR, g: FastGen): string | null {
  const x = g.input;
  const parts: string[] = [`typeof ${x}==="object"`, `${x}!==null`, `!Array.isArray(${x})`];

  for (const [key, propIR] of Object.entries(ir.properties)) {
    const propExpr = `${x}[${escapeString(key)}]`;
    const propCheck = g.visit(propIR, { input: propExpr });
    if (propCheck === null) return null; // All-or-nothing
    parts.push(propCheck);
  }

  // Strict unknown-key pass: hosted boolean helper (a for-in loop cannot live
  // in the && chain). Same for-in iteration as the slow path — fast/slow
  // agreement is load-bearing under the __zcFinD deferral.
  if (ir.strict) {
    const keys = Object.keys(ir.properties);
    const fnName = g.temp("so");
    const test = keyMembershipTest(keys, "k", () => emitSet(g.ctx, "ks", keys));
    g.ctx.preamble.push(
      `function ${fnName}(o){for(var k in o){if(!(${test}))return false;}return true;}`,
    );
    parts.push(`${fnName}(${x})`);
  }

  // Object-level refine effects (appended last — run after property checks short-circuit)
  if (ir.checks) {
    for (const check of ir.checks) {
      if (check.kind === "refine_effect") {
        parts.push(`${emitEffectFn(g.ctx, check.source)}(${x})`);
      }
    }
  }

  return parts.join("&&");
}
