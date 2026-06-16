import { describe, expect, it } from "vitest";
import { ZodRealError, z } from "zod";
import { FAIL_CLASS_DECL, FIN_DECL, FIN_DEFERRED_DECL } from "#src/core/iife.js";
import { compileSchemas } from "#src/core/pipeline.js";

const __zcFin = new Function("__zcZodError", `${FAIL_CLASS_DECL}${FIN_DECL}; return __zcFin;`)(
  ZodRealError,
);

describe("compileSchemas", () => {
  it("returns CompiledSchemaInfo for each schema", () => {
    const schemas = [
      { exportName: "validateUser", schema: z.object({ name: z.string() }) },
      { exportName: "validatePost", schema: z.object({ title: z.string() }) },
    ];
    const { schemas: results } = compileSchemas(schemas, { mode: "inline" });

    expect(results).toHaveLength(2);
    expect(results[0]?.exportName).toBe("validateUser");
    expect(results[1]?.exportName).toBe("validatePost");
    expect(results[0]?.codegenResult.functionDef).toContain("safeParse_validateUser");
    expect(results[1]?.codegenResult.functionDef).toContain("safeParse_validatePost");
  });

  it("threads stripUnknownKeys into extraction", () => {
    const schemas = [{ exportName: "validateUser", schema: z.object({ a: z.string() }) }];

    const off = compileSchemas(schemas, { mode: "inline" });
    // Default: mutation-free object takes the by-reference fast path.
    expect(off.schemas[0]?.codegenResult.functionDef).toContain("data:input");
    expect(off.schemas[0]?.codegenResult.functionDef).not.toContain("__zcHop.call");

    const on = compileSchemas(schemas, { mode: "inline", stripUnknownKeys: true });
    // Stripping: rebuild a fresh object, copying own keys via hasOwnProperty;
    // no by-reference fast path.
    expect(on.schemas[0]?.codegenResult.functionDef).toContain("__zcHop.call");
    expect(on.schemas[0]?.codegenResult.functionDef).not.toContain("data:input");
  });

  it("collects refEntries independently per schema", () => {
    // Use captured-variable transforms to ensure fallback (zero-capture transforms are now compiled)
    const external = "prefix_";
    const schemas = [
      {
        exportName: "withFallback",
        schema: z.object({
          name: z.string(),
          slug: z.string().transform((v) => external + v),
        }),
      },
      {
        exportName: "noFallback",
        schema: z.object({ name: z.string() }),
      },
    ];
    const { schemas: results } = compileSchemas(schemas, { mode: "inline" });

    expect(results[0]?.refEntries.length).toBeGreaterThan(0);
    expect(results[0]?.codegenResult.refCount).toBe(results[0]?.refEntries.length);
    expect(results[1]?.refEntries).toHaveLength(0);
    expect(results[1]?.codegenResult.refCount).toBe(0);
  });

  it("zero-capture transform/refine produce no fallback entries", () => {
    const schema = z.object({
      a: z.string().transform((v) => v),
      b: z.string(),
      c: z.number().refine((v) => v > 0),
    });
    const { schemas: results } = compileSchemas([{ exportName: "test", schema }], {
      mode: "inline",
    });

    // Zero-capture transform and refine are now compiled (no fallback)
    expect(results[0]?.refEntries.length).toBe(0);
    expect(results[0]?.codegenResult.refCount).toBe(0);
  });

  it("propagates refCount to codegenResult for captured-variable transforms", () => {
    const external1 = "a";
    const external2 = "b";
    const schema = z.object({
      a: z.string().transform((v) => external1 + v),
      b: z.string(),
      c: z.number().transform((v) => v + Number(external2)),
    });
    const { schemas: results } = compileSchemas([{ exportName: "test", schema }], {
      mode: "inline",
    });

    expect(results[0]?.codegenResult.refCount).toBe(results[0]?.refEntries.length);
    // a (captured transform) + c (captured transform)
    expect(results[0]?.refEntries.length).toBe(2);
  });

  it("continues on error when onError is provided", () => {
    const schemas = [
      { exportName: "badOne", schema: null },
      { exportName: "goodOne", schema: z.object({ name: z.string() }) },
    ];
    const errors: { name: string; error: Error }[] = [];
    const { schemas: results } = compileSchemas(schemas, {
      mode: "inline",
      onError(name: string, error: Error) {
        errors.push({ name, error });
      },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.name).toBe("badOne");
    expect(results).toHaveLength(1);
    expect(results[0]?.exportName).toBe("goodOne");
  });

  it("throws on error when onError is not provided", () => {
    const schemas = [{ exportName: "badOne", schema: null }];

    expect(() => compileSchemas(schemas, { mode: "inline" })).toThrow();
  });

  it("generates valid code for each schema", () => {
    const schemas = [
      {
        exportName: "validateUser",
        schema: z.object({ name: z.string().min(1), age: z.number() }),
      },
    ];
    const { schemas: results } = compileSchemas(schemas, { mode: "inline" });
    const code = results[0]?.codegenResult.code;
    const fnName = results[0]?.codegenResult.functionDef;

    expect(code).toBeDefined();
    expect(fnName).toBeDefined();

    // Verify generated code is syntactically valid
    expect(() => new Function(`${code}\nreturn ${fnName};`)).not.toThrow();
  });

  it("factory default produces correct runtime values via __rf[]", () => {
    let counter = 0;
    const schema = z.object({ id: z.number() }).default(() => ({ id: counter++ }));
    const { schemas: results } = compileSchemas([{ exportName: "factoryDefault", schema }], {
      mode: "inline",
    });
    const info = results[0];
    expect(info).toBeDefined();

    const fbArr = info?.refEntries.map((e) => e.schema) ?? [];
    const fn = new Function(
      "__zcZodError",
      "__zcFin",
      "__rf",
      `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\n${info?.codegenResult.code}\nreturn ${info?.codegenResult.functionDef};`,
    )(ZodRealError, __zcFin, fbArr);

    // Each call with undefined should invoke the factory, producing different values
    const r1 = fn(undefined);
    const r2 = fn(undefined);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.data.id).not.toBe(r2.data.id);
  });

  it("factory Date default works at runtime via __rf[]", () => {
    const schema = z.date().default(() => new Date());
    const { schemas: results } = compileSchemas([{ exportName: "dateFactory", schema }], {
      mode: "inline",
    });
    const info = results[0];
    expect(info).toBeDefined();

    const fbArr = info?.refEntries.map((e) => e.schema) ?? [];
    const fn = new Function(
      "__zcZodError",
      "__zcFin",
      "__rf",
      `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\n${info?.codegenResult.code}\nreturn ${info?.codegenResult.functionDef};`,
    )(ZodRealError, __zcFin, fbArr);

    const r1 = fn(undefined);
    expect(r1.success).toBe(true);
    expect(r1.data).toBeInstanceOf(Date);

    // Valid Date input should also work
    const d = new Date("2024-01-01");
    const r2 = fn(d);
    expect(r2.success).toBe(true);
    expect(r2.data).toEqual(d);
  });

  it("static default still works via __rf[] runtime reference", () => {
    const schema = z.string().default("hello");
    const { schemas: results } = compileSchemas([{ exportName: "staticDefault", schema }], {
      mode: "inline",
    });
    const info = results[0];
    expect(info).toBeDefined();

    const fbArr = info?.refEntries.map((e) => e.schema) ?? [];
    const fn = new Function(
      "__zcZodError",
      "__zcFin",
      "__rf",
      `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\n${info?.codegenResult.code}\nreturn ${info?.codegenResult.functionDef};`,
    )(ZodRealError, __zcFin, fbArr);

    expect(fn(undefined)).toEqual({ success: true, data: "hello" });
    expect(fn("world")).toEqual({ success: true, data: "world" });
    expect(fn(42).success).toBe(false);
  });

  it("factory UUID default produces unique values each time", () => {
    const schema = z.uuid().default(() => crypto.randomUUID());
    const { schemas: results } = compileSchemas([{ exportName: "uuidFactory", schema }], {
      mode: "inline",
    });
    const info = results[0];
    expect(info).toBeDefined();

    const fbArr = info?.refEntries.map((e) => e.schema) ?? [];
    const fn = new Function(
      "__zcZodError",
      "__zcFin",
      "__rf",
      `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\n${info?.codegenResult.code}\nreturn ${info?.codegenResult.functionDef};`,
    )(ZodRealError, __zcFin, fbArr);

    // undefined → factory generates unique UUID each time
    const r1 = fn(undefined);
    const r2 = fn(undefined);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.data).toMatch(/^[0-9a-f]{8}-/);
    expect(r2.data).toMatch(/^[0-9a-f]{8}-/);
    expect(r1.data).not.toBe(r2.data);

    // Valid UUID input → fast path returns as-is
    const validUuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(fn(validUuid)).toEqual({ success: true, data: validUuid });

    // Invalid string → fails validation
    expect(fn("not-a-uuid").success).toBe(false);

    // undefined → result matches Zod behavior
    const zodResult = schema.safeParse(undefined);
    expect(zodResult.success).toBe(true);
  });

  it("factory timestamp default produces different values each call", () => {
    // performance.now() has microsecond precision — no need for setTimeout
    const schema = z.number().default(() => performance.now());
    const { schemas: results } = compileSchemas([{ exportName: "tsFactory", schema }], {
      mode: "inline",
    });
    const info = results[0];
    expect(info).toBeDefined();

    const fbArr = info?.refEntries.map((e) => e.schema) ?? [];
    const fn = new Function(
      "__zcZodError",
      "__zcFin",
      "__rf",
      `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\n${info?.codegenResult.code}\nreturn ${info?.codegenResult.functionDef};`,
    )(ZodRealError, __zcFin, fbArr);

    const r1 = fn(undefined);
    const r2 = fn(undefined);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(typeof r1.data).toBe("number");
    expect(typeof r2.data).toBe("number");
    expect(r2.data).not.toBe(r1.data);

    // Explicit number input bypasses default
    expect(fn(42)).toEqual({ success: true, data: 42 });
  });

  it("nested default inside object uses correct sub-schema via __rf[]", () => {
    let counter = 0;
    const schema = z.object({
      name: z.string(),
      role: z.string().default("user"),
      seq: z.number().default(() => counter++),
    });
    const { schemas: results } = compileSchemas([{ exportName: "nestedDefault", schema }], {
      mode: "inline",
    });
    const info = results[0];
    expect(info).toBeDefined();
    expect(info?.refEntries.length).toBeGreaterThanOrEqual(2);

    const fbArr = info?.refEntries.map((e) => e.schema) ?? [];
    const fn = new Function(
      "__zcZodError",
      "__zcFin",
      "__rf",
      `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\n${info?.codegenResult.code}\nreturn ${info?.codegenResult.functionDef};`,
    )(ZodRealError, __zcFin, fbArr);

    // Omitted fields get defaults
    const r1 = fn({ name: "alice" });
    expect(r1.success).toBe(true);
    expect(r1.data.role).toBe("user");
    expect(typeof r1.data.seq).toBe("number");

    // Factory default produces different values
    const r2 = fn({ name: "bob" });
    expect(r2.success).toBe(true);
    expect(r2.data.seq).not.toBe(r1.data.seq);

    // Explicit values bypass defaults
    const r3 = fn({ name: "carol", role: "admin", seq: 999 });
    expect(r3.success).toBe(true);
    expect(r3.data.role).toBe("admin");
    expect(r3.data.seq).toBe(999);

    // Matches Zod behavior
    const zodResult = schema.safeParse({ name: "dave" });
    expect(zodResult.success).toBe(true);
    if (zodResult.success) {
      expect(zodResult.data.role).toBe("user");
    }
  });
});
