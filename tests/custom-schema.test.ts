/**
 * z.custom() and z.instanceof() are pure predicate schemas: the predicate can
 * decide the hot-path verdict, while Zod remains the source of truth for the
 * exact cold-path issue shape.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import type { CustomIR } from "#src/core/types.js";
import { expectParity } from "./parity-harness.js";

function extractWithRefs(schema: unknown): {
  ir: ReturnType<typeof extractSchema>;
  refs: RefEntry[];
} {
  const refs: RefEntry[] = [];
  return { ir: extractSchema(schema, refs), refs };
}

describe("custom schema extraction", () => {
  it("inlines a zero-capture z.custom predicate and retains only its error delegate", () => {
    const { ir, refs } = extractWithRefs(z.custom<string>((value) => typeof value === "string"));
    expect(ir).toMatchObject({ type: "custom", abort: true, schemaRefIndex: 0 });
    expect((ir as CustomIR).source).toContain("typeof value");
    expect((ir as CustomIR).refIndex).toBeUndefined();
    expect(refs.map((ref) => ref.accessPath)).toEqual([""]);
  });

  it("calls captured custom and instanceof predicates by reference", () => {
    const minimum = 10;
    const captured = extractWithRefs(z.custom<number>((value) => value >= minimum));
    expect(captured.ir).toMatchObject({
      type: "custom",
      refIndex: 0,
      schemaRefIndex: 1,
      abort: true,
    });
    expect(captured.refs.map((ref) => ref.accessPath)).toEqual(["._zod.def.fn", ""]);

    class Token {}
    const instance = extractWithRefs(z.instanceof(Token));
    expect(instance.ir).toMatchObject({ type: "custom", refIndex: 0, schemaRefIndex: 1 });
    expect(instance.refs[0]?.schema).toBeTypeOf("function");
  });

  it("keeps callbacks requiring Zod's async/context protocol on fallback", () => {
    const asyncSchema = z.custom(async () => true);
    expect(extractWithRefs(asyncSchema).ir.type).toBe("fallback");
    expectParity(asyncSchema, [1]);
    expect(
      extractWithRefs(z.custom(((_value: unknown, _ctx: unknown) => true) as never)).ir.type,
    ).toBe("fallback");
  });

  it("keeps the predicate compiled under an input-dependent error map", () => {
    // The issue was Zod's to build already (schemaRefIndex), so a dynamic map
    // changes nothing: Zod calls it while producing that issue.
    const schema = z.custom(() => false, { error: (issue) => `bad ${String(issue.input)}` });
    expect(extractWithRefs(schema).ir).toMatchObject({ type: "custom", schemaRefIndex: 0 });
    expectParity(schema, [1, "x"]);
  });

  it("emits a total deferred fast path", () => {
    const { ir, refs } = extractWithRefs(z.instanceof(Date));
    const generated = generateValidator(ir, "custom", { refCount: refs.length });
    expect(generated.fastTotal).toBe(true);
    expect(generated.functionDef).toContain("__zcFinD");
  });
});

describe("custom schema parity", () => {
  it("matches custom verdicts, paths, static messages, and truthy returns", () => {
    expectParity(
      z.custom<string>((value) => typeof value === "string"),
      ["ok", 1, null],
    );
    expectParity(
      z.custom<number>((value) => value > 0, { message: "positive", path: ["amount"] }),
      [1, 0, -1, "1"],
    );
    expectParity(
      z.custom(() => "truthy" as unknown as boolean),
      [undefined, null, 1],
    );
  });

  it("matches captured predicates and nested everyday objects", () => {
    const minimum = 10;
    class Token {}
    const schema = z.object({
      score: z.custom<number>((value) => typeof value === "number" && value >= minimum),
      token: z.instanceof(Token),
    });
    expectParity(schema, [
      { score: 10, token: new Token(), extra: "stripped" },
      { score: 9, token: new Token() },
      { score: 10, token: {} },
      { score: "10", token: new Token() },
      null,
    ]);
  });

  it("preserves named class instanceof errors and subclasses", () => {
    class Base {}
    class Child extends Base {}
    expectParity(z.instanceof(Base), [new Base(), new Child(), {}, null, "Base"]);
  });

  it("preserves aborting and continuable custom options inside unions", () => {
    expectParity(z.union([z.custom(() => false), z.string()]), [1, null]);
    expectParity(z.union([z.custom(() => false, { abort: false }), z.string()]), [1, null]);
  });

  it("raises $ZodAsyncError for a sync function returning a Promise", () => {
    expectParity(
      z.custom(() => Promise.resolve(true)),
      [1],
    );
  });
});
