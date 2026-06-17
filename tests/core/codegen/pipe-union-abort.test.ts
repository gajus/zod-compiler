/**
 * Pipe/codec/transform "aborted" propagation in union pruning. zod's
 * handlePipeResult sets payload.aborted when a pipe's `in` (or a transform's
 * inner) fails, and util.aborted then excludes that option from union pruning
 * regardless of issue code. These cases exercise the abort signal reaching the
 * union through every path it travels: a pipe's `out`, a `.default()` wrapper,
 * a transform `effect`, and a shared (deduped) slow-walk option.
 */
import { describe, expect, it } from "vitest";
import { ZodRealError, z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { FAIL_CLASS_DECL, FIN_DECL, FIN_DEFERRED_DECL } from "#src/core/iife.js";
import { compileSchemas, type CompiledSchemaInfo } from "#src/core/pipeline.js";

const localizedFin = new Function(
  "__zcMsg",
  "__zcZodError",
  `${FAIL_CLASS_DECL}${FIN_DECL}; return __zcFin;`,
)(z.config().localeError, ZodRealError);
const localizedFinD = new Function(
  "__zcMsg",
  "__zcZodError",
  `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}; return __zcFinD;`,
)(z.config().localeError, ZodRealError);

function compileOne(schema: unknown): (i: unknown) => {
  success: boolean;
  error?: { issues: unknown[] };
} {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const generated = generateValidator(ir, "rec", { refCount: refEntries.length });
  const factory = new Function(
    "__zcMsg",
    "__zcZodError",
    "__zcFin",
    "__rf",
    `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\n${generated.code}\nreturn ${generated.functionDef};`,
  );
  return factory(
    z.config().localeError,
    ZodRealError,
    localizedFin,
    refEntries.map((e) => e.schema),
  );
}

function buildShared(
  info: CompiledSchemaInfo,
  sharedCode: string,
): (i: unknown) => {
  success: boolean;
  error?: { issues: unknown[] };
} {
  const fnName = /function (safeParse_\w+)/.exec(info.codegenResult.functionDef)?.[1];
  if (!fnName) throw new Error("no fn");
  const src = `${sharedCode}\nreturn (function(){\n${info.codegenResult.code}\n${info.codegenResult.functionDef}\nreturn ${fnName};\n})();`;
  return new Function("__zcMsg", "__zcZodError", "__zcFin", "__zcFinD", "__rf", src)(
    z.config().localeError,
    ZodRealError,
    localizedFin,
    localizedFinD,
    info.refEntries.map((e) => e.schema),
  );
}

const norm = (issues: { path: unknown; code?: unknown; message?: unknown }[]) =>
  issues.map((i) => ({ path: i.path, code: i.code, message: i.message }));

function expectParity(fn: (i: unknown) => unknown, schema: z.ZodType, inputs: unknown[]): void {
  for (const input of inputs) {
    const got = fn(input) as { success: boolean; error?: { issues: unknown[] } };
    const want = schema.safeParse(input);
    expect(got.success, `accept :: ${String(input)}`).toBe(want.success);
    if (!want.success) {
      expect(norm(got.error?.issues as never[]), `issues :: ${String(input)}`).toEqual(
        norm(want.error.issues as never[]),
      );
    }
  }
}

describe("pipe/transform abort propagation to union pruning", () => {
  it("A: pipe whose `out` is an abort-bearing nested pipe", () => {
    const inner = z
      .string()
      .refine(() => false, { error: "innerA" })
      .pipe(z.string());
    const schema = z.union([z.string().pipe(inner), z.number()]);
    expectParity(compileOne(schema), schema, ["x", 5, true]);
  });

  it("B: pipe under .default() as a union option", () => {
    const P = z
      .string()
      .refine(() => false, { error: "innerB" })
      .pipe(z.string());
    const schema = z.union([P.default("d"), z.string().refine(() => false, { error: "sibB" })]);
    expectParity(compileOne(schema), schema, ["x", 5]);
  });

  it("C: transform whose inner fails, as a union option", () => {
    const schema = z.union([
      z
        .string()
        .refine(() => false, { error: "innerC" })
        .transform((v) => v),
      z.string().refine(() => false, { error: "sibC" }),
    ]);
    expectParity(compileOne(schema), schema, ["x", 5]);
  });

  it("D: shared-walk dedup of a pipe union-option", () => {
    const P = z
      .string()
      .refine(() => false, { error: "innerD" })
      .pipe(z.string());
    const RootA = z.union([P, z.number()]);
    const RootB = z.union([P, z.boolean()]);
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "RootA", schema: RootA },
        { exportName: "RootB", schema: RootB },
      ],
      { mode: "inline" },
    );
    const fnA = buildShared(
      schemas.find((s) => s.exportName === "RootA") as CompiledSchemaInfo,
      shared.code,
    );
    expectParity(fnA, RootA, ["x", 5, true]);
  });
});
