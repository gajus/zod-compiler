/**
 * Cheapest-first ordering of fast-path conjuncts.
 *
 * A fast check is one `&&` chain (options one `||` chain). Accepting input runs
 * every conjunct whatever the order, so ordering is free on the hot path; a
 * REJECT stops at the first false one, which is why a `z.email()` emitted ahead
 * of the `kind` literal that actually discriminates makes union probing and
 * `.is()` misses pay a regex per option. Ordering by estimated runtime cost
 * (fast-size.ts) fixes that.
 *
 * The reordering is FAST-PATH ONLY: the slow walk's output is the issue list,
 * whose order is part of zod parity, so it keeps declaration order. Both
 * properties are pinned here — the emitted shape, and full parity with zod.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { expectParity } from "../../parity-harness.js";

const fastCheckOf = (schema: z.ZodType): string =>
  generateValidator(extractSchema(schema), "t").code;

/** Index of `needle` in the emitted fast check (-1 when absent). */
const posIn = (code: string, needle: string): number => code.indexOf(needle);

describe("fast-path check ordering", () => {
  it("emits an object's cheap literal before its regex format check", () => {
    const code = fastCheckOf(
      z.object({
        email: z.email(),
        kind: z.literal("alpha"),
        note: z.string(),
      }),
    );
    const kind = posIn(code, '["kind"]==="alpha"');
    const email = posIn(code, "__zcEmail(input");
    expect(kind).toBeGreaterThanOrEqual(0);
    expect(email).toBeGreaterThanOrEqual(0);
    expect(kind).toBeLessThan(email);
  });

  it("emits scalar properties before nested containers", () => {
    const code = fastCheckOf(
      z.object({
        items: z.array(z.object({ a: z.string(), b: z.number() })),
        ok: z.boolean(),
      }),
    );
    expect(posIn(code, '["ok"]')).toBeLessThan(posIn(code, '["items"]'));
  });

  it("keeps declaration order for equal-cost properties", () => {
    const code = fastCheckOf(z.object({ a: z.string(), b: z.string(), c: z.string() }));
    expect(posIn(code, '["a"]')).toBeLessThan(posIn(code, '["b"]'));
    expect(posIn(code, '["b"]')).toBeLessThan(posIn(code, '["c"]'));
  });

  it("probes the cheaper union option first", () => {
    const code = fastCheckOf(z.union([z.email(), z.literal("none")]));
    expect(posIn(code, '==="none"')).toBeLessThan(posIn(code, "__zcEmail(input"));
  });

  it("checks the cheaper intersection side first", () => {
    // Objects strip, and zod's parse-both-sides-then-merge cannot be
    // reproduced by validating one value twice — so an intersection OF OBJECTS
    // delegates to zod entirely. Order is still pinned for sides that compile.
    const code = fastCheckOf(z.intersection(z.email(), z.string().min(1)));
    expect(posIn(code, ".length>=1")).toBeLessThan(posIn(code, "__zcEmail(input"));
  });

  it("checks the cheaper tuple position first", () => {
    const code = fastCheckOf(z.tuple([z.email(), z.boolean()]));
    expect(posIn(code, "[1]")).toBeLessThan(posIn(code, "__zcEmail(input"));
  });

  it("leaves the slow walk in declaration order (issue order is zod parity)", () => {
    const schema = z.object({
      email: z.email(),
      kind: z.literal("alpha"),
      note: z.string(),
    });
    const generated = generateValidator(extractSchema(schema), "t");
    const walk = generated.code + generated.functionDef;
    // The slow walk pushes issues per property; the email issue must be first.
    const emailIssue = walk.indexOf('path:["email"]');
    const kindIssue = walk.indexOf('path:["kind"]');
    expect(emailIssue).toBeGreaterThanOrEqual(0);
    expect(kindIssue).toBeGreaterThan(emailIssue);
  });
});

describe("fast-path check ordering — parity", () => {
  const mixed = z.object({
    email: z.email(),
    kind: z.literal("alpha"),
    nested: z.object({ deep: z.array(z.string()), flag: z.boolean() }),
    note: z.string().min(2),
  });
  const valid = {
    email: "user@example.com",
    kind: "alpha",
    nested: { deep: ["x"], flag: true },
    note: "ok",
  };

  it("accept/reject/issue order match zod across single- and multi-failure inputs", () => {
    expectParity(mixed, [
      valid,
      { ...valid, kind: "beta" },
      { ...valid, email: "nope" },
      { ...valid, note: "x" },
      // multiple failures at once — issue ORDER must still follow declaration order
      { ...valid, email: "nope", kind: "beta", note: "x" },
      { ...valid, nested: { deep: [1], flag: "no" } },
      { email: "user@example.com" },
      null,
      [],
      "string",
    ]);
  });

  it("union probing matches zod for every option and for misses", () => {
    const option = (kind: string) =>
      z.object({ email: z.email(), kind: z.literal(kind), note: z.string() });
    const union = z.union([option("alpha"), option("beta"), option("gamma")]);
    expectParity(union, [
      { email: "a@b.co", kind: "alpha", note: "n" },
      { email: "a@b.co", kind: "gamma", note: "n" },
      { email: "a@b.co", kind: "delta", note: "n" },
      { email: "bad", kind: "beta", note: "n" },
      { kind: "beta" },
    ]);
  });

  it("tuple and intersection reordering match zod", () => {
    expectParity(z.tuple([z.email(), z.boolean()]), [
      ["a@b.co", true],
      ["bad", true],
      ["a@b.co", "no"],
      ["a@b.co"],
    ]);
    expectParity(z.intersection(z.object({ email: z.email() }), z.object({ id: z.string() })), [
      { email: "a@b.co", id: "x" },
      { email: "bad", id: "x" },
      { email: "a@b.co", id: 1 },
    ]);
  });
});
