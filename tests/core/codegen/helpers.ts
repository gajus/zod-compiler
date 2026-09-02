import { core as zodCore, ZodRealError } from "zod";
import type { CodeGenContext } from "#src/core/codegen/context.js";
import { declareFastTemps } from "#src/core/codegen/context.js";
import { createFastGen, generateFast } from "#src/core/codegen/fast-path.js";
import { generateValidator } from "#src/core/codegen/index.js";
import { FAIL_CLASS_DECL, FIN_DECL, FIN_DEFERRED_DECL } from "#src/core/iife.js";
import type { SchemaIR } from "#src/core/types.js";

// __zcMsg intentionally undefined: codegen tests verify raw issues, not locale-transformed messages.
// FAIL_CLASS_DECL hosts the shared failure-result prototype both finalizers construct.
const __zcFin = new Function(
  "__zcMsg",
  "__zcZodError",
  `${FAIL_CLASS_DECL}${FIN_DECL}; return __zcFin;`,
)(undefined, ZodRealError);
const __zcFinD = new Function(
  "__zcMsg",
  "__zcZodError",
  `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}; return __zcFinD;`,
)(undefined, ZodRealError);

/**
 * Generated code ships inside ES modules, which are always strict — so every
 * harness compiles it strict too. Without this, an assignment to an undeclared
 * identifier quietly creates a global here and throws a ReferenceError in the
 * bundle (a shipped `z.date().min()` fast check did exactly that).
 */
const STRICT = '"use strict";';

/**
 * Helper: generate code from IR, compile it, and return the safeParse function.
 */
export function compileIR(
  ir: SchemaIR,
  name = "test",
  refSchemas?: unknown[],
): (input: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown[] } } {
  const result = generateValidator(ir, name, {
    refCount: refSchemas?.length ?? 0,
  });
  // `__zcCore` is the zod core namespace production imports beside the error
  // class: a delegate runs the retained schema through `_zod.run` and finalizes
  // its issues with `core.util.finalizeIssue`, and a callback returning a
  // Promise throws `core.$ZodAsyncError`.
  const fn =
    refSchemas && refSchemas.length > 0
      ? new Function(
          "__zcZodError",
          "__zcCore",
          "__zcFin",
          "__zcFinD",
          "__rf",
          `${STRICT}${result.code}\nreturn ${result.functionDef};`,
        )
      : new Function(
          "__zcZodError",
          "__zcCore",
          "__zcFin",
          "__zcFinD",
          `${STRICT}${result.code}\nreturn ${result.functionDef};`,
        );
  return (
    refSchemas && refSchemas.length > 0
      ? fn(ZodRealError, zodCore, __zcFin, __zcFinD, refSchemas)
      : fn(ZodRealError, zodCore, __zcFin, __zcFinD)
  ) as (input: unknown) => {
    success: boolean;
    data?: unknown;
    error?: { issues: unknown[] };
  };
}

/**
 * Helper: compile a fast-check expression from IR and return a boolean function.
 * Returns null if the schema is not eligible for fast-check.
 */
export function compileFastCheck(ir: SchemaIR): ((input: unknown) => boolean) | null {
  const ctx: CodeGenContext = {
    preamble: [],
    counter: 0,
    fnName: "test",
    regexCache: new Map(),
    mode: "inline",
    usedHelpers: new Set(),
  };
  const g = createFastGen("input", ctx);
  const expr = generateFast(ir, g);
  if (expr === null) return null;
  if (expr === "true") return () => true;
  if (expr === "false") return () => false;
  // Mirrors generateValidator: the function hosting the expression declares the
  // scope's temps. STRICT is what makes a missed declaration fail loudly here
  // (an implicit global otherwise), so keep both together.
  const code = [
    STRICT,
    ...ctx.preamble,
    `return function(input){${declareFastTemps(g.scope)}return ${expr};}`,
  ].join("\n");
  return new Function(code)() as (input: unknown) => boolean;
}
