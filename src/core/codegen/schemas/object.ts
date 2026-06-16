import type { ObjectIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import {
  ENUM_INLINE_THRESHOLD,
  emitEffectFn,
  emitRuntimeHelper,
  emitSet,
  escapeString,
  extendStaticPath,
  hasMutation,
} from "../context.js";
import { emit } from "../emit.js";
import { invalidType, unrecognizedKeys } from "../emit-issue.js";
import { ZC_HOP_DECL } from "../issue-decls.js";
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

  // Strip mode (zod's default z.object() output) rebuilds a FRESH object from
  // only the declared own keys, so it always writes back. Otherwise clone only
  // when a property mutates the value.
  const strip = ir.stripUnknownKeys === true;
  const needsClone = strip || Object.values(ir.properties).some(hasMutation);
  const objVar = g.temp("o");
  if (strip) {
    code += `var ${objVar}={};`;
  } else {
    // Spread, not Object.assign: V8's CloneObjectIC makes `{...x}` ~25% faster
    // on the whole safeParse call for mutation-bearing schemas.
    code += needsClone ? `var ${objVar}={...${g.input}};` : `var ${objVar}=${g.input};`;
  }
  // Own-property guard for the strip copy (matches zod's own-key read and the
  // {...input} clone — symbol, inherited, and unknown keys never carry over).
  const hop = strip ? emitRuntimeHelper(g.ctx, "__zcHop", ZC_HOP_DECL) : "";

  const suppressAbsent = new Set(ir.suppressAbsentKeys ?? []);
  for (const [key, propIR] of Object.entries(ir.properties)) {
    const keyStr = escapeString(key);
    const propExpr = `${objVar}[${keyStr}]`;
    const propPath = extendStaticPath(g.path, key);
    if (strip) {
      // Copy the present own key into the fresh object BEFORE its in-place
      // validation, so the existing per-property logic (plain copy, defaults,
      // overwrites, nested rebuilds) runs unchanged on `objVar`. Absent keys
      // stay absent; a default fills them in via its own `===undefined` branch.
      code += `if(${hop}.call(${g.input},${keyStr})){${propExpr}=${g.input}[${keyStr}];}`;
    }
    const propCode = g.visit(propIR, { input: propExpr, output: propExpr, path: propPath });
    if (suppressAbsent.has(key)) {
      // Mirrors zod's handlePropertyResult: optional-out fallback props run,
      // but their issues are discarded when the key is absent from the input.
      const beforeVar = g.temp("ob");
      code += emit`
        var ${beforeVar}=${g.issues}.length;
        ${propCode}
        if(!(${keyStr} in ${objVar})&&${g.issues}.length>${beforeVar}){
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

/**
 * Property/strict/refine fast-checks for an object, WITHOUT the leading
 * `typeof===object && !==null && !Array.isArray` type-guard. Returns the
 * conjunct parts (joinable with `&&`), or null if any child is fast-ineligible.
 *
 * `skipKey`, when given, omits that one property's check. Used by the
 * discriminated-union fast path (via `g.discSkipKey`): the enclosing `switch`
 * has already matched the discriminator's value, so re-checking it is redundant.
 */
function fastObjectBody(ir: ObjectIR, g: FastGen, skipKey?: string): string[] | null {
  const x = g.input;
  const parts: string[] = [];

  for (const [key, propIR] of Object.entries(ir.properties)) {
    if (key === skipKey) continue;
    const propExpr = `${x}[${escapeString(key)}]`;
    const propCheck = g.visit(propIR, { input: propExpr });
    if (propCheck === null) return null; // All-or-nothing
    parts.push(propCheck);
  }

  // Strict unknown-key pass: hosted boolean helper (a for-in loop cannot live
  // in the && chain). Same for-in iteration as the slow path — fast/slow
  // agreement is load-bearing under the __zcFinD deferral. The membership set is
  // the FULL key list (the discriminator is a recognized key), independent of
  // skipKey, which only suppresses re-validating the discriminator's value.
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

  return parts;
}

export function fastObject(ir: ObjectIR, g: FastGen): string | null {
  // Strip rebuilds a fresh output, so there is no by-reference fast path: fall
  // to the eager slow build (mirrors how .trim()/overwrite disables fastString).
  // Disabling it here also propagates up — any container holding a strip object
  // loses its fast path too, and `.is()` derives from safeParse(input).success.
  if (ir.stripUnknownKeys) return null;
  const x = g.input;
  const body = fastObjectBody(ir, g, g.discSkipKey);
  if (body === null) return null;
  // Discriminated-union option: the enclosing switch (and the caller's guard)
  // already established object-ness and the discriminator value, so emit only
  // the remaining checks — no leading type-guard. An option with nothing left
  // to check accepts unconditionally ("true").
  if (g.discSkipKey !== undefined) {
    return body.length > 0 ? body.join("&&") : "true";
  }
  return [`typeof ${x}==="object"`, `${x}!==null`, `!Array.isArray(${x})`, ...body].join("&&");
}
