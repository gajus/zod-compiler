/**
 * Non-root recursion targets: recursive schemas that are NOT the compiled root
 * (nested inside a wrapper, multiple distinct recursive shapes in one root,
 * mutual recursion) compile to hosted `__rsp_N` / `__fcr_N` validators instead
 * of delegating to Zod. Each case asserts:
 *   1. zero fallback refs (the recursion is genuinely compiled, not delegated), and
 *   2. accept/reject + full issue (path, code, message) parity against Zod,
 * through a production-equivalent pipeline (real ZodError, locale wired).
 */
import { describe, expect, it } from "vitest";
import { ZodRealError, z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { FAIL_CLASS_DECL, FIN_DECL, FIN_DEFERRED_DECL } from "#src/core/iife.js";

const localizedFin = new Function(
  "__zcMsg",
  "__zcZodError",
  `${FAIL_CLASS_DECL}${FIN_DECL}; return __zcFin;`,
)(z.config().localeError, ZodRealError);

function compileLikeProduction(schema: unknown): {
  fn: (input: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown[] } };
  refCount: number;
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
  const fn = factory(
    z.config().localeError,
    ZodRealError,
    localizedFin,
    refEntries.map((e) => e.schema),
  );
  return { fn, refCount: refEntries.length };
}

/** Assert the schema compiled fully (no fallbacks) and matches Zod on every sample. */
function expectParity(schema: z.ZodType, samples: unknown[]): void {
  const { fn, refCount } = compileLikeProduction(schema);
  expect(refCount, "schema should compile with no Zod-delegated fallbacks").toBe(0);
  for (const input of samples) {
    const got = fn(input);
    const want = schema.safeParse(input);
    const label = JSON.stringify(input) ?? String(input);
    expect(got.success, `accept/reject :: ${label}`).toBe(want.success);
    if (!want.success) {
      const norm = (issues: { path: unknown; code?: unknown; message?: unknown }[]) =>
        issues.map((i) => ({ path: i.path, code: i.code, message: i.message }));
      expect(norm(got.error?.issues as never[]), `issues :: ${label}`).toEqual(
        norm(want.error.issues as never[]),
      );
    }
  }
}

describe("codegen — non-root recursion targets", () => {
  it("recursive schema nested inside a wrapper", () => {
    const Inner: z.ZodType = z.object({
      val: z.string(),
      self: z.array(z.lazy(() => Inner)),
    });
    const Wrapper = z.object({ meta: z.string(), node: Inner });
    expectParity(Wrapper, [
      { meta: "m", node: { val: "a", self: [] } },
      { meta: "m", node: { val: "a", self: [{ val: "b", self: [] }] } },
      { meta: "m", node: { val: "a", self: [{ val: 9, self: [] }] } },
      { meta: 1, node: { val: "a", self: [] } },
      { meta: "m", node: { val: "a", self: "nope" } },
      { meta: "m", node: { val: "a", self: [{ val: "b", self: [{ val: 2, self: [] }] }] } },
      "wrong",
    ]);
  });

  it("two distinct recursive sub-schemas under one root", () => {
    const TreeA: z.ZodType = z.object({ a: z.string(), kids: z.array(z.lazy(() => TreeA)) });
    const TreeB: z.ZodType = z.object({ b: z.number().int(), kids: z.array(z.lazy(() => TreeB)) });
    const Root = z.object({ x: TreeA, y: TreeB });
    expectParity(Root, [
      { x: { a: "s", kids: [] }, y: { b: 1, kids: [] } },
      { x: { a: "s", kids: [{ a: "t", kids: [] }] }, y: { b: 1, kids: [{ b: 2, kids: [] }] } },
      { x: { a: "s", kids: [{ a: 5, kids: [] }] }, y: { b: 1, kids: [] } },
      { x: { a: "s", kids: [] }, y: { b: 1.5, kids: [] } },
    ]);
  });

  it("mutual recursion nested under a root", () => {
    const A: z.ZodType = z.object({ tag: z.literal("a"), b: z.lazy(() => B).optional() });
    const B: z.ZodType = z.object({ tag: z.literal("b"), a: z.lazy(() => A).optional() });
    const Root = z.object({ start: A });
    expectParity(Root, [
      { start: { tag: "a" } },
      { start: { tag: "a", b: { tag: "b", a: { tag: "a" } } } },
      { start: { tag: "a", b: { tag: "x" } } },
      { start: { tag: "b" } },
    ]);
  });

  it("recursive JSON value nested in a field", () => {
    const Json: z.ZodType = z.lazy(() =>
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(Json),
        z.record(z.string(), Json),
      ]),
    );
    const Env = z.object({ payload: Json });
    expectParity(Env, [
      { payload: "x" },
      { payload: [1, "a", true, null] },
      { payload: { a: 1, b: [2, { c: "d" }] } },
      { payload: { bad: undefined } },
    ]);
  });

  it("checks inside the recursive node still validate (min length)", () => {
    const Node: z.ZodType = z.object({
      name: z.string().min(2),
      children: z.array(z.lazy(() => Node)),
    });
    const Doc = z.object({ root: Node });
    expectParity(Doc, [
      { root: { name: "ok", children: [] } },
      { root: { name: "x", children: [] } },
      { root: { name: "ok", children: [{ name: "y", children: [] }] } },
    ]);
  });

  it("self-recursive root remains correct (regression)", () => {
    const Cat: z.ZodType = z.object({
      name: z.string(),
      sub: z.array(z.lazy(() => Cat)),
    });
    expectParity(Cat, [
      { name: "a", sub: [] },
      { name: "a", sub: [{ name: "b", sub: [] }] },
      { name: 1, sub: [] },
      { name: "a", sub: [{ name: "b", sub: [{ name: 2, sub: [] }] }] },
    ]);
  });
});
