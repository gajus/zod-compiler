import { ZodRealError } from "zod";
import type { CodeGenContext } from "#src/core/codegen/context.js";
import { createFastGen, generateFast } from "#src/core/codegen/fast-path.js";
import { generateValidator } from "#src/core/codegen/index.js";
import { FIN_DECL, FIN_DEFERRED_DECL } from "#src/core/iife.js";
import type { SchemaIR } from "#src/core/types.js";

// __zcMsg intentionally undefined: codegen tests verify raw issues, not locale-transformed messages.
const __zcFin = new Function("__zcMsg", "__zcZodError", `${FIN_DECL}; return __zcFin;`)(
  undefined,
  ZodRealError,
);
const __zcFinD = new Function("__zcMsg", "__zcZodError", `${FIN_DEFERRED_DECL}; return __zcFinD;`)(
  undefined,
  ZodRealError,
);

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
  const fn =
    refSchemas && refSchemas.length > 0
      ? new Function(
          "__zcZodError",
          "__zcFin",
          "__zcFinD",
          "__rf",
          `${result.code}\nreturn ${result.functionDef};`,
        )
      : new Function(
          "__zcZodError",
          "__zcFin",
          "__zcFinD",
          `${result.code}\nreturn ${result.functionDef};`,
        );
  return (
    refSchemas && refSchemas.length > 0
      ? fn(ZodRealError, __zcFin, __zcFinD, refSchemas)
      : fn(ZodRealError, __zcFin, __zcFinD)
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
  const code = [...ctx.preamble, `return function(input){return ${expr};}`].join("\n");
  return new Function(code)() as (input: unknown) => boolean;
}
