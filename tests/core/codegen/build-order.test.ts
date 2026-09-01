import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { compileLikeProduction, expectParity } from "../../parity-harness.js";

/**
 * The build path validates an object's properties cheapest-first and assembles
 * the output in shape order (see orderedForBuild). Rejected input is then
 * decided by a type guard instead of by the most expensive check that happens
 * to be declared first; accepted input runs everything either way.
 *
 * Properties whose parse is observable — a transform, a default, a coercion —
 * are pinned to declaration order, after the free ones, so effects still fire
 * in zod's order on a successful parse.
 */
function buildSource(schema: unknown): string {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const result = generateValidator(ir, "o", { refCount: refEntries.length });
  expect(result.functionDef, "schema should take the build path").toMatch(/=__vb_\d+\(input\)/);
  const start = result.code.indexOf("function __vb_");
  expect(start).toBeGreaterThanOrEqual(0);
  return result.code.slice(start);
}

describe("build path — cheapest-first property validation", () => {
  const schema = z.object({
    email: z.email(),
    kind: z.literal("alpha"),
    note: z.string(),
    flag: z.boolean(),
  });

  it("checks the cheap literal and boolean before the email scan", () => {
    const source = buildSource(schema);
    const flag = source.indexOf('==="boolean"');
    const kind = source.indexOf('==="alpha"');
    const email = source.indexOf("__zcEmail(");
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(kind).toBeGreaterThanOrEqual(0);
    expect(email).toBeGreaterThanOrEqual(0);
    expect(flag).toBeLessThan(email);
    expect(kind).toBeLessThan(email);
  });

  it("still assembles the output in shape order", () => {
    const source = buildSource(schema);
    expect(source).toMatch(/\{"email":__bv_\d+,"kind":__bv_\d+,"note":__bv_\d+,"flag":__bv_\d+\}/);
    const parsed = compileLikeProduction(schema)({
      flag: true,
      note: "n",
      kind: "alpha",
      email: "a@b.co",
      extra: 1,
    });
    expect(parsed.success).toBe(true);
    expect(Object.keys((parsed as { data: object }).data)).toEqual([
      "email",
      "kind",
      "note",
      "flag",
    ]);
  });

  it("agrees with zod on verdicts, output and issue order", () => {
    expectParity(
      schema,
      [
        { email: "a@b.co", kind: "alpha", note: "n", flag: true },
        { email: "a@b.co", kind: "alpha", note: "n", flag: "yes" },
        { email: "nope", kind: "alpha", note: "n", flag: true },
        { email: "nope", kind: "beta", note: 1, flag: "no" },
        { kind: "alpha" },
        {},
        null,
      ],
      "ordered",
    );
  });

  it("pins transforms to declaration order, after the free checks", () => {
    const log: string[] = [];
    const pinned = z.object({
      a: z.string().transform((v) => {
        log.push("a");
        return v;
      }),
      n: z.number(),
      b: z.string().transform((v) => {
        log.push("b");
        return v;
      }),
      flag: z.boolean(),
    });
    // `Number(...)`-free free checks come first, then the two transforms in
    // declaration order — the same order zod fires them in.
    const source = buildSource(pinned);
    const rfA = source.indexOf("__rfn_");
    expect(source.indexOf('==="boolean"')).toBeLessThan(rfA);
    expect(source.indexOf("Number.isFinite(")).toBeLessThan(rfA);

    const compiled = compileLikeProduction(pinned);
    const input = { a: "x", n: 1, b: "y", flag: false };
    log.length = 0;
    pinned.safeParse(input);
    const zodOrder = [...log];
    log.length = 0;
    compiled(input);
    expect(log).toEqual(zodOrder);
    expect(log).toEqual(["a", "b"]);

    // A rejected parse fires neither transform: the cheap checks decide first.
    log.length = 0;
    expect(compiled({ a: "x", n: 1, b: "y", flag: "no" }).success).toBe(false);
    expect(log).toEqual([]);
  });

  it("pins coercions and defaults too", () => {
    const source = buildSource(
      z.object({ n: z.coerce.number(), page: z.number().default(1), flag: z.boolean() }),
    );
    const flag = source.indexOf('==="boolean"');
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(flag).toBeLessThan(source.indexOf("Number("));
    expect(flag).toBeLessThan(source.indexOf("defaultValue"));
    expect(source.indexOf("Number(")).toBeLessThan(source.indexOf("defaultValue"));
  });

  it("leaves an object whose properties are all pinned in declaration order", () => {
    const source = buildSource(
      z.object({ a: z.coerce.number(), b: z.coerce.string(), c: z.coerce.boolean() }),
    );
    expect(source.indexOf("Number(")).toBeLessThan(source.indexOf("String("));
    expect(source.indexOf("String(")).toBeLessThan(source.indexOf("Boolean("));
  });
});
