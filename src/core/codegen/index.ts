import type { SchemaIR } from "../types.js";
import type { CodeGenContext, CodeGenResult, CodegenMode } from "./context.js";
import { emitRfDelegate, hasMutation } from "./context.js";
import { createFastGen, generateFast } from "./fast-path.js";
import { createSlowGen, generateSlow } from "./slow-path.js";

export type { CodeGenResult } from "./context.js";

export interface GenerateValidatorOptions {
  refCount?: number;
  /** Codegen output mode. Defaults to "inline". */
  mode?: CodegenMode;
}

/**
 * Generate optimized validation code from SchemaIR.
 *
 * - `code`: preamble declarations (Sets, RegExps, etc.) — deterministic for the same IR
 * - `functionDef`: full function expression string referencing preamble vars via closure
 * - `usedHelpers`: helper names from "virtual:zod-compiler/runtime" referenced (lean mode only)
 *
 * Usage: `new Function(code + "\nreturn " + functionDef + ";")()`
 */
export function generateValidator(
  ir: SchemaIR,
  name: string,
  options?: GenerateValidatorOptions,
): CodeGenResult {
  const fnName = `safeParse_${name}`;
  const mode: CodegenMode = options?.mode ?? "inline";
  const ctx: CodeGenContext = {
    preamble: [],
    counter: 0,
    fnName,
    regexCache: new Map(),
    mode,
    usedHelpers: new Set(),
  };

  // Root-level fallback: the whole schema delegates to Zod, so zod's own
  // safeParse result IS the result. Returning it directly skips the issue
  // copy loop (which would force zod's eager ZodError construction), the
  // pointless [].concat(path) rewrites, and the __zcFin re-wrap. Delegation
  // goes through the pre-mutation capture (emitRfDelegate) — here __rf[0]
  // and the __zcMkv target are routinely the SAME object.
  if (ir.type === "fallback" && ir.refIndex !== undefined) {
    const delegate = emitRfDelegate(ctx, ir.refIndex);
    return {
      code: ["/* zod-compiler */", ...ctx.preamble].join("\n"),
      functionDef: `function ${fnName}(input){return ${delegate}(input);}`,
      refCount: options?.refCount ?? 0,
      usedHelpers: ctx.usedHelpers,
      fastFnName: null,
    };
  }

  // Fast Path: generate a boolean expression for eligible schemas
  const fg = createFastGen("input", ctx);
  let fastExpr = generateFast(ir, fg);

  // Host the fast expression in a named boolean helper. Self-recursive
  // schemas need it so recursive refs can call it; every other eligible
  // schema benefits too: __zcMkv wires it into parse()/parseAsync(), whose
  // success paths then return the input directly — no intermediate
  // SafeParseResult allocation (the safeParse function body is far past
  // V8's inlining budget, so escape analysis never removes it).
  let fastFnName: string | null = null;
  if (fastExpr !== null && fastExpr !== "true") {
    fastFnName = ctx.recFastName ?? `__fc_${ctx.counter++}`;
    ctx.preamble.push(`function ${fastFnName}(input){return ${fastExpr};}`);
    fastExpr = `${fastFnName}(input)`;
  }

  const sg = createSlowGen("_d", "_d", "[]", "_e", ctx);
  const slowCode = generateSlow(ir, sg);

  const buildCode = (): string => ["/* zod-compiler */", ...ctx.preamble].join("\n");

  const functionDefParts = [`function ${fnName}(input){`];

  if (fastExpr === "true") {
    // Schema always succeeds (any/unknown) — skip slow path entirely
    functionDefParts.push(`return{success:true,data:input};`);
    functionDefParts.push(`}`);
    return {
      code: buildCode(),
      functionDef: functionDefParts.join("\n"),
      refCount: options?.refCount ?? 0,
      usedHelpers: ctx.usedHelpers,
      fastFnName: null,
    };
  }

  if (fastExpr !== null && !hasMutation(ir)) {
    // Mutation-free schemas with a fast path: a fast-check failure can never
    // become a slow-path success (both are generated from the same checks —
    // unlike default/catch/coerce schemas, whose partial fast path requires
    // value presence while the slow path SUCCEEDS by applying the default).
    // The slow path's only output is therefore the issues array, observable
    // solely through `.error` — defer the whole re-walk into the cached
    // accessor (__zcFinD): a failed safeParse whose `.error` is never read
    // costs the fast check alone.
    //
    // The walk is HOSTED as a named preamble function rather than a per-call
    // closure, for two measured reasons: (1) a failed safeParse no longer
    // allocates a closure environment + function object before the deferral
    // even starts; (2) the safeParse body shrinks to two statements, putting
    // it within V8's inlining budget — callers in hot loops get the
    // success-path result object escape-analyzed away entirely, which the
    // old shape (slow walk inlined into the body) made impossible.
    ctx.usedHelpers.add("__zcFinD");
    if (slowCode.includes(fnName)) {
      // Self-recursive slow paths call the safeParse function by NAME
      // (slowRecursiveRef) — that binding exists only inside the named
      // function expression under the documented evaluation contract
      // (`new Function(code + "return " + functionDef)`), so the walk stays
      // a per-call closure for recursive schemas. Recursion is the rare
      // shape; everything else gets the hosted walk.
      functionDefParts.push(
        `if(${fastExpr}){return{success:true,data:input};}`,
        `return __zcFinD(function(input){`,
        `var _e=[];`,
        `var _d=input;`,
        slowCode,
        `return _e;`,
        `},input);`,
        `}`,
      );
    } else {
      const walkName = `__sw_${ctx.counter++}`;
      ctx.preamble.push(
        `function ${walkName}(input){var _e=[];\nvar _d=input;\n${slowCode}\nreturn _e;}`,
      );
      functionDefParts.push(
        `if(${fastExpr}){return{success:true,data:input};}`,
        `return __zcFinD(${walkName},input);`,
        `}`,
      );
    }
    return {
      code: buildCode(),
      functionDef: functionDefParts.join("\n"),
      refCount: options?.refCount ?? 0,
      usedHelpers: ctx.usedHelpers,
      fastFnName,
    };
  }

  if (fastExpr !== null) {
    // Partial fast path (default/catch/... present-value shortcut): the slow
    // path must run eagerly — it can succeed where the fast check failed.
    functionDefParts.push(`if(${fastExpr}){return{success:true,data:input};}`);
  }

  // Success branch inlined at the call site instead of inside __zcFin: the
  // eager path (mutation schemas — coerce/default/trim/transform) returns
  // here on EVERY parse, and the inline literal keeps the hot exit free of a
  // cross-function call; __zcFin is reached only on failure.
  functionDefParts.push(
    `var _e=[];`,
    `var _d=input;`,
    slowCode,
    `if(_e.length===0){return{success:true,data:_d};}`,
    `return __zcFin(_e,_d);`,
    `}`,
  );

  const functionDef = functionDefParts.join("\n");

  return {
    code: buildCode(),
    functionDef,
    refCount: options?.refCount ?? 0,
    usedHelpers: ctx.usedHelpers,
    fastFnName,
  };
}
