import type { ObjectIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import {
  declareFastTemps,
  emitRuntimeHelper,
  escapeString,
  extendPath,
  extendStaticPath,
  hasMutation,
  keyMembershipTest,
  outputAlwaysDefined,
} from "../context.js";
import { emit } from "../emit.js";
import { invalidType, unrecognizedKeys } from "../emit-issue.js";
import { ZC_AB_DECL, ZC_PROTO_SCRUB_DECL } from "../issue-decls.js";
import { orderByRuntimeCost } from "../fast-size.js";
import { fastRefineTest, refineCheck, superRefineCheck, superRefineFastTest } from "./effect.js";

/**
 * The shape entries whose schemas actually RUN. `$ZodObject` skips a declared
 * `__proto__` key in its shape loop (`if (key === "__proto__") continue`), so
 * that property is never validated and never written to the output — it is
 * only a recognized name for the strict/catchall passes, which read
 * `Object.keys(ir.properties)` directly. Writing it would be worse than
 * pointless: `{__proto__: v}` in an object literal, and `o["__proto__"] = v`
 * on a plain object, both SET THE PROTOTYPE rather than define a key.
 */
export function parsedProperties(ir: ObjectIR): [string, SchemaIR][] {
  return Object.entries(ir.properties).filter(([key]) => key !== "__proto__");
}

export function slowObject(ir: SchemaIR & { type: "object" }, g: SlowGen): string {
  let code = emit`
    if(typeof ${g.input}!=="object"||${g.input}===null||Array.isArray(${g.input})){
      ${invalidType(g, "object")}
    }else{`;

  // zod parses every object into a FRESH `{}`: the shape keys land first, in
  // shape order (handlePropertyResult), and a loose or catchall object then
  // appends the unknown keys in the input's for-in order (handleCatchall).
  //
  // Two modes reproduce that. REBUILD assembles exactly that object: always
  // for strip mode (zod's default z.object() output is only the declared keys),
  // and for a loose, strict or catchall object whenever a property or the
  // catchall rewrites its value — a rewritten value has to land somewhere, and
  // a spread clone of the input (what this once did) put it at the wrong
  // position: the input's key order, with a substituted key appended last.
  // PASS-THROUGH hands the input back by reference when nothing rewrites
  // anything; identity, key order and inherited keys then ride along with it,
  // which is the documented container-identity divergence (see
  // known-divergences.test.ts).
  const strip = ir.stripUnknownKeys === true;
  const rebuild =
    strip ||
    (ir.catchall !== undefined && hasMutation(ir.catchall)) ||
    Object.values(ir.properties).some(hasMutation);
  const objVar = g.temp("o");
  if (!rebuild) {
    code += `var ${objVar}=${g.input};`;
    // The pass-through output is the input, and an own `__proto__` must not
    // ride along on it where zod's fresh `{}` never receives the key. Scrub it
    // (see ZC_PROTO_SCRUB_DECL); a rebuilt object never copies the key in the
    // first place.
    const scrub = emitRuntimeHelper(g.ctx, "__zcPs", ZC_PROTO_SCRUB_DECL);
    code += `${objVar}=${scrub}(${objVar});`;
  }
  /**
   * Pass-through only: land a nested node's REPLACEMENT value on the output.
   * A pass-through property never rewrites its value (that is what
   * pass-through means), but a nested object or record can still hand back a
   * proto-scrubbed COPY of its input, and that copy has to reach the output
   * object — not the caller's object. Writing it straight into `objVar` did
   * exactly that when `objVar` was the input: the caller's own object was
   * edited in place (its nested value swapped for the copy), and a frozen
   * input threw "Cannot assign to read only property" out of `safeParse`. So
   * the output becomes a copy of its own the first time a replacement lands,
   * and only then. Spread is safe here: `objVar` is still the input only when
   * the scrub above found no own `__proto__` on it.
   */
  const handoff = (outVar: string, inVar: string, keyExpr: string): string =>
    `if(${outVar}!==${inVar}){if(${objVar}===${g.input}){${objVar}={...${g.input}};}${objVar}[${keyExpr}]=${outVar};}`;

  // Object-level refines are gated on zod's ABORT rule, not on "did anything
  // fail": zod parses the properties (plus the strict/catchall passes) into the
  // payload and then skips its check chain only when `util.aborted` holds — i.e.
  // when one of those issues is non-continuable. A property that failed its own
  // `min`/format check reports a CONTINUABLE issue, so the outer refine still
  // runs and both messages surface — and so does an unrecognized key, which zod
  // pushes with `continue: true`; a property that failed to parse at all
  // (`invalid_type`, a bad record key) aborts and suppresses it. Snapshot the
  // issue count before the properties so the scan covers exactly this node's
  // own parse, as zod's fresh sub-payload does.
  const refineMark = ir.checks && ir.checks.length > 0 ? g.temp("rm") : "";
  if (refineMark) code += `var ${refineMark}=${g.issues}.length;`;

  const skipAbsent = new Set(ir.skipAbsentKeys ?? []);
  const suppressAbsent = new Set(ir.suppressAbsentKeys ?? []);
  const nonoptional = new Set(ir.nonoptionalKeys ?? []);
  /** Rebuild only: per-property output slot + whether it is always in the result. */
  const slots: { always: boolean; keyStr: string; value: string }[] = [];

  for (const [key, propIR] of parsedProperties(ir)) {
    const keyStr = escapeString(key);
    const propPath = extendStaticPath(g.ctx, g.path, key);
    // Every mode validates the value read from the ORIGINAL input, held in a
    // local. zod parses `input[key]` — a prototype-inclusive read — so a value
    // found on the prototype is accepted and, on a rebuild, copied out as an
    // own key. Reading through a spread clone, as the loose/strict/catchall
    // branch once did, turned such a value into `undefined` (spread copies own
    // keys only): the fast and build paths, which read `input[key]`, rejected
    // the input, this walk then found nothing wrong with it, and a strict
    // object came back as a failure with an EMPTY issue list. The local also
    // spares every check the megamorphic re-load of `o[key]` — the clone's map
    // changed with every key added.
    const propExpr = g.temp("sv");
    code += `var ${propExpr}=${g.input}[${keyStr}];`;
    // A rebuild assembles the output from the local afterwards (in shape order,
    // below). A pass-through property is handed a slot of its own to write a
    // replacement into, which `handoff` then lands on the output.
    let outExpr = propExpr;
    if (rebuild) {
      slots.push({ always: outputAlwaysDefined(propIR), keyStr, value: propExpr });
    } else {
      outExpr = g.temp("ov");
      code += `var ${outExpr}=${propExpr};`;
    }
    const propCode = g.visit(propIR, { input: propExpr, output: outExpr, path: propPath });
    // The three absent-key rules of zod's handlePropertyResult (see ObjectIR).
    // Presence is tested on the ORIGINAL input, as zod's `key in input` is —
    // a clone would hide an inherited key.
    //
    // The two rules that test presence AFTER running the property snapshot it
    // FIRST, exactly as zod reads `isPresent` before it looks at the result. A
    // property writes nowhere but its own local, so nothing it makes of
    // `undefined` can create the very key it is asked about (writing straight
    // into the output object once did that: `z.looseObject({a: z.custom()})` on
    // `{}` lost its `nonoptional` issue and left the caller's object carrying
    // an `a` zod never writes); dropping its value is resetting that local.
    const dropValue = rebuild ? `${propExpr}=undefined;` : `${outExpr}=${propExpr};`;
    if (skipAbsent.has(key)) {
      code += emit`if(${keyStr} in ${g.input}){${propCode}}`;
    } else if (suppressAbsent.has(key)) {
      // A defaulted optional-out property runs, but a failure on an absent key
      // is discarded whole: issues and whatever value it wrote before failing.
      const beforeVar = g.temp("ob");
      const presentVar = g.temp("op");
      code += emit`
        var ${presentVar}=${keyStr} in ${g.input};
        var ${beforeVar}=${g.issues}.length;
        ${propCode}
        if(!${presentVar}&&${g.issues}.length>${beforeVar}){
          ${g.issues}.length=${beforeVar};${dropValue}
        }`;
    } else if (nonoptional.has(key)) {
      // A required key that is absent fails as such when its schema raised
      // nothing for the `undefined` it saw. zod pushes this one without an
      // `inst`, so no schema-level message reaches it — and it returns without
      // assigning, so whatever the property made of `undefined` is dropped.
      const beforeVar = g.temp("ob");
      const presentVar = g.temp("op");
      code += emit`
        var ${presentVar}=${keyStr} in ${g.input};
        var ${beforeVar}=${g.issues}.length;
        ${propCode}
        if(!${presentVar}){
          ${dropValue}
          if(${g.issues}.length===${beforeVar}){
            ${invalidType(g, "nonoptional", { input: "undefined", path: propPath, codeFirst: true, useTypeMsg: false })}
          }
        }`;
    } else {
      code += propCode;
    }
    if (!rebuild) code += handoff(outExpr, propExpr, keyStr);
  }

  if (rebuild) {
    // Assemble the result in shape order (zod's key order), taking as long a
    // LEADING run of always-present keys as possible into one object literal:
    // V8 stamps a literal out of a cached boilerplate map in a single
    // allocation, where adding keys one at a time walks a transition chain and
    // re-checks the map on every store — measured 8.1x (20 keys) / 2.8x (7
    // keys, one optional) on the whole safeParse.
    //
    // Everything after the first conditional key is appended so insertion order
    // still matches zod. The per-key test is zod's own: keep the key when the
    // parsed value is defined, or when it was present on the input at all
    // (`key in input`, prototype included — an own `k: undefined` survives).
    const literal: string[] = [];
    let appends = "";
    let leading = true;
    for (const slot of slots) {
      if (leading && slot.always) {
        literal.push(`${slot.keyStr}:${slot.value}`);
        continue;
      }
      leading = false;
      appends += slot.always
        ? `${objVar}[${slot.keyStr}]=${slot.value};`
        : `if(${slot.value}!==undefined||(${slot.keyStr} in ${g.input})){${objVar}[${slot.keyStr}]=${slot.value};}`;
    }
    code += `var ${objVar}={${literal.join(",")}};${appends}`;

    // A rebuilt loose object then takes every unknown key, in the input's
    // for-in order — zod's handleCatchall running its `unknown` catchall, which
    // hands each value back as it is and assigns it as an own key, inherited
    // ones included. (A catchall with a schema does the same in its own pass
    // below; a strict object reports the keys instead.)
    if (!strip && !ir.strict && ir.catchall === undefined) {
      const kVar = g.temp("lk");
      const test = keyMembershipTest(g.ctx, Object.keys(ir.properties), kVar);
      code += emit`
        for(var ${kVar} in ${g.input}){
          if(!(${test})&&${kVar}!=="__proto__"){${objVar}[${kVar}]=${g.input}[${kVar}];}
        }`;
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
    const test = keyMembershipTest(g.ctx, keys, kVar);
    code += emit`
      var ${ukVar}=null;
      for(var ${kVar} in ${g.input}){
        if(!(${test})){(${ukVar}=${ukVar}||[]).push(${kVar});}
      }
      if(${ukVar}!==null){
        ${unrecognizedKeys(g, ukVar)}
      }`;
  }

  // .catchall(schema): validate every key NOT in the shape, mirroring zod's
  // handleCatchall — same bare for-in over the ORIGINAL input as the strict
  // pass (inherited enumerable keys count, no hasOwnProperty guard), each
  // issue reported at the key. Runs after the properties, as zod does. An
  // undeclared `__proto__` is skipped like zod skips it: never validated, and
  // never assigned, since `o["__proto__"]=v` on a plain object would replace
  // its prototype instead of adding a key. (The strict pass above still
  // REPORTS it — there it is an unknown key like any other.)
  //
  // On a rebuild each unknown key is copied onto the fresh output before it is
  // validated — which reproduces zod, whose fresh output object gains an OWN
  // key for every for-in key it saw, inherited ones included, whether or not
  // the catchall accepted its value. The key's slot is then BOTH the input and
  // the output, exactly as a shape property's local is: a value-rewriting
  // catchall (coerce, .trim(), a default) writes through the same expression
  // it later re-reads, so splitting them makes the rewrite invisible to its own
  // checks. A pass-through catchall writes nothing, so the object stays by
  // reference; it gets the same replacement slot a pass-through property does,
  // for the same reason.
  if (ir.catchall) {
    const keys = Object.keys(ir.properties);
    const kVar = g.temp("ck");
    const test = keyMembershipTest(g.ctx, keys, kVar);
    const catchallPath = extendPath(g.ctx, g.path, kVar);
    let body: string;
    if (rebuild) {
      const slot = `${objVar}[${kVar}]`;
      body = `${slot}=${g.input}[${kVar}];${g.visit(ir.catchall, { input: slot, output: slot, path: catchallPath })}`;
    } else {
      const inVar = g.temp("cv");
      const outVar = g.temp("co");
      body =
        `var ${inVar}=${g.input}[${kVar}];var ${outVar}=${inVar};` +
        g.visit(ir.catchall, { input: inVar, output: outVar, path: catchallPath }) +
        handoff(outVar, inVar, kVar);
    }
    code += emit`
      for(var ${kVar} in ${g.input}){
        if(!(${test})&&${kVar}!=="__proto__"){${body}}
      }`;
  }

  // Always written back: a rebuild is a fresh object, and a pass-through may
  // have become a copy (the scrub above, or a handoff) even where nothing
  // rewrote a value.
  code += `${g.output}=${objVar};`;

  // Object-level refine effects: z.object({...}).refine(fn), suppressed when the
  // parse phase aborted (see refineMark). One gate covers every effect: each of
  // them can only add a continuable `custom` issue, so zod's per-check
  // re-evaluation of `isAborted` can never flip between them.
  if (ir.checks && ir.checks.length > 0) {
    let refines = "";
    for (const check of ir.checks) {
      refines +=
        check.kind === "super_refine_effect"
          ? superRefineCheck(check, objVar, g)
          : refineCheck(check, objVar, g);
    }
    const aborted = emitRuntimeHelper(g.ctx, "__zcAb", ZC_AB_DECL);
    code += `if(!${aborted}(${g.issues},${refineMark})){${refines}}`;
  }

  code += `}\n`;
  return code;
}

/**
 * Property entries in the order their fast-checks should be `&&`-chained:
 * cheapest first, declaration order preserved among equals (Array#sort is
 * stable). Valid input runs every conjunct whatever the order, so this costs
 * nothing on the hot path; a REJECT stops at the first false conjunct, so
 * pricing a `z.email()` behind the `kind` literal that actually discriminates
 * is what makes union probing and `.is()` misses cheap (see
 * estimateRuntimeCost). The SLOW path keeps declaration order — that one's
 * output is the issue list, whose order is part of zod parity.
 */
function orderedProperties(ir: ObjectIR, g: FastGen): [string, SchemaIR][] {
  return orderByRuntimeCost(parsedProperties(ir), ([, propIR]) => propIR, g.ctx);
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
  const absentAccepts = new Set([...(ir.skipAbsentKeys ?? []), ...(ir.suppressAbsentKeys ?? [])]);
  const nonoptional = new Set(ir.nonoptionalKeys ?? []);

  for (const [key, propIR] of orderedProperties(ir, g)) {
    if (key === skipKey) continue;
    const keyStr = escapeString(key);
    const propCheck = g.visit(propIR, { input: `${x}[${keyStr}]` });
    if (propCheck === null) return null; // All-or-nothing
    // Presence rules keyed on the schema's `optin`/`optout` (see ObjectIR): a
    // required key must be there whatever its schema makes of `undefined`, and
    // an optional-out key on the "optional"/"defaulted" rungs is accepted when
    // it is not, whatever the property would say.
    if (nonoptional.has(key)) {
      parts.push(propCheck === "true" ? `${keyStr} in ${x}` : `${keyStr} in ${x}&&${propCheck}`);
    } else if (absentAccepts.has(key)) {
      parts.push(`(!(${keyStr} in ${x})||${propCheck})`);
    } else {
      parts.push(propCheck);
    }
  }

  // Strict unknown-key pass: hosted boolean helper (a for-in loop cannot live
  // in the && chain). Same for-in iteration as the slow path — fast/slow
  // agreement is load-bearing under the __zcFinD deferral. The membership set is
  // the FULL key list (the discriminator is a recognized key), independent of
  // skipKey, which only suppresses re-validating the discriminator's value.
  if (ir.strict) {
    const keys = Object.keys(ir.properties);
    const fnName = g.temp("so");
    const test = keyMembershipTest(g.ctx, keys, "k");
    g.ctx.preamble.push(
      `function ${fnName}(o){for(var k in o){if(!(${test}))return false;}return true;}`,
    );
    parts.push(`${fnName}(${x})`);
  }

  // .catchall(schema): same hosted for-in as strict, but each unrecognized key
  // is checked against the catchall rather than rejected outright. The value is
  // hoisted into a local for the same reason fastRecord does it — repeated
  // `o[k]` computed loads are not eliminated across check boundaries.
  if (ir.catchall) {
    const kv = g.temp("cak");
    const vv = g.temp("cav");
    const catchallGen = g.scoped(vv);
    const valCheck = catchallGen.visit(ir.catchall, { input: vv });
    if (valCheck === null) return null;
    if (valCheck !== "true") {
      const fnName = g.temp("co");
      const test = keyMembershipTest(g.ctx, Object.keys(ir.properties), kv);
      g.ctx.preamble.push(
        `function ${fnName}(o){${declareFastTemps(catchallGen.scope)}var ${kv},${vv};for(${kv} in o){if(!(${test})&&${kv}!=="__proto__"){${vv}=o[${kv}];if(!(${valCheck}))return false;}}return true;}`,
      );
      parts.push(`${fnName}(${x})`);
    }
  }

  // Object-level refine effects (appended last — run after property checks short-circuit)
  if (ir.checks) {
    for (const check of ir.checks) {
      if (check.kind === "refine_effect") {
        parts.push(fastRefineTest(check, x, g));
      } else if (check.kind === "super_refine_effect") {
        parts.push(superRefineFastTest(check, x, g));
      }
    }
  }

  return parts;
}

export function fastObject(ir: ObjectIR, g: FastGen): string | null {
  // A strip object still gets an expression. Stripping reshapes the OUTPUT, not
  // the verdict, so this remains an exact acceptance predicate — which is what
  // `.is()` installs, and what the build path reuses to validate the subtrees it
  // passes through by reference. What it must NOT do is stand in for the parse
  // result: generateValidator withholds the `data:input` shortcut whenever the
  // schema rebuilds (see rebuildsOutput).
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
