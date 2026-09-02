import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { jit } from "#src/jit.js";

/**
 * Plain-union option pruning against zod's `handleUnionResults`: when every
 * option fails, zod surfaces the ONE non-aborted option's own issues, or wraps
 * all of them in `invalid_union` when there is no such option or several.
 * "Aborted" is `util.aborted(payload)`: the payload's `aborted` bit, or any
 * issue whose `continue` is not `true` — and those issues travel up through
 * containers with the flag intact, so an aborting failure deep inside an
 * option's object aborts the option.
 *
 * The compiled union used to miss three sources of that flag: a delegated node
 * (whose issues arrived already finalized, `continue` deleted — every
 * `z.custom()`, which zod defaults to `abort: true`, and every `abort: true`
 * refine), a template literal (a node-level `invalid_format`, unlike the
 * check-level one every string format raises) and a fatal superRefine below
 * the option root. Each surfaced the leaf issue where zod reports
 * `invalid_union`.
 */
const isStr = (v: unknown) => typeof v === "string";
const fatal = (v: string, ctx: z.RefinementCtx) => {
  if (v === "bad") ctx.addIssue({ code: "custom", message: "bad", fatal: true });
};
const shorthand = (v: string, ctx: z.RefinementCtx) => {
  if (v === "bad") ctx.addIssue("bad");
};

const cases: [string, () => z.ZodType, unknown][] = [
  // aborting below the option root: zod wraps in invalid_union
  ["custom in object", () => z.union([z.object({ a: z.custom(isStr) }), z.number()]), { a: 1 }],
  ["custom in array", () => z.union([z.array(z.custom(isStr)), z.number()]), [1]],
  ["custom in tuple", () => z.union([z.tuple([z.custom(isStr)]), z.number()]), [1]],
  [
    "custom in record",
    () => z.union([z.record(z.string(), z.custom(isStr)), z.number()]),
    { a: 1 },
  ],
  [
    "custom in nested object",
    () => z.union([z.object({ n: z.object({ a: z.custom(isStr) }) }), z.number()]),
    { n: { a: 1 } },
  ],
  [
    "custom behind optional tags (GraphQL shape)",
    () =>
      z.union([
        z.object({ __typename: z.literal("A").optional(), a: z.custom(isStr) }),
        z.object({ __typename: z.literal("B").optional(), b: z.string() }),
      ]),
    { a: ["x"] },
  ],
  [
    "refine abort:true at option root",
    () => z.union([z.string().refine((s) => s !== "bad", { abort: true }), z.number()]),
    "bad",
  ],
  [
    "refine abort:true in object",
    () =>
      z.union([
        z.object({ a: z.string().refine((s) => s !== "bad", { abort: true }) }),
        z.number(),
      ]),
    { a: "bad" },
  ],
  [
    "template literal at option root",
    () => z.union([z.templateLiteral(["a", z.number()]), z.number()]),
    "zz",
  ],
  [
    "template literal in object",
    () => z.union([z.object({ t: z.templateLiteral(["a", z.number()]) }), z.number()]),
    { t: "zz" },
  ],
  [
    "fatal superRefine in object",
    () => z.union([z.object({ a: z.string().superRefine(fatal) }), z.number()]),
    { a: "bad" },
  ],
  [
    "string-shorthand superRefine in object",
    () => z.union([z.object({ a: z.string().superRefine(shorthand) }), z.number()]),
    { a: "bad" },
  ],
  [
    "fatal superRefine at option root",
    () => z.union([z.string().superRefine(fatal), z.number()]),
    "bad",
  ],
  [
    "pipe at option root",
    () =>
      z.union([
        z
          .string()
          .refine((s) => s !== "bad")
          .pipe(z.string().min(2)),
        z.number(),
      ]),
    "bad",
  ],
  // continuable below the option root: zod surfaces the leaf
  [
    "custom abort:false in object",
    () => z.union([z.object({ a: z.custom(isStr, { abort: false }) }), z.number()]),
    { a: 1 },
  ],
  [
    "plain refine in object",
    () => z.union([z.object({ a: z.string().refine((s) => s.length > 3) }), z.number()]),
    { a: "x" },
  ],
  [
    "delegated date refine in object",
    () => z.union([z.object({ a: z.date().refine((d) => d.getTime() > 0) }), z.number()]),
    { a: new Date(0) },
  ],
  [
    "delegated dynamic message in object",
    () => z.union([z.object({ a: z.string().min(2, { error: () => "dyn" }) }), z.number()]),
    { a: "x" },
  ],
  [
    "non-fatal superRefine in object",
    () =>
      z.union([
        z.object({
          a: z.string().superRefine((v, ctx) => {
            if (v === "bad") ctx.addIssue({ code: "custom", message: "bad" });
          }),
        }),
        z.number(),
      ]),
    { a: "bad" },
  ],
  [
    "pipe in object (payload flag does not travel)",
    () =>
      z.union([
        z.object({
          a: z
            .string()
            .refine((s) => s !== "bad")
            .pipe(z.string().min(2)),
        }),
        z.number(),
      ]),
    { a: "bad" },
  ],
  // both options aborting for ordinary reasons stays invalid_union
  [
    "two invalid_type options",
    () => z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
    { a: 1 },
  ],
  // discriminated unions dispatch and are unaffected
  [
    "discriminated union with custom",
    () =>
      z.discriminatedUnion("k", [
        z.object({ k: z.literal("a"), a: z.custom(isStr) }),
        z.object({ k: z.literal("b") }),
      ]),
    { k: "a", a: 1 },
  ],
];

describe("union option pruning matches zod's util.aborted", () => {
  for (const [name, mk, input] of cases) {
    it(name, () => {
      const plain = mk();
      const compiled = jit(mk(), { eager: true });
      const expected = plain.safeParse(input);
      const actual = compiled.safeParse(input);
      expect(actual.success).toBe(expected.success);
      if (expected.success || actual.success) return;
      expect(actual.error.issues).toEqual(expected.error.issues);
      expect(actual.error.message).toBe(expected.error.message);
      // The abort marker is zod bookkeeping and never reaches the caller.
      for (const issue of actual.error.issues) expect("continue" in issue).toBe(false);
    });
  }

  it("still accepts the matching option and its output", () => {
    const mk = () =>
      z.union([
        z.object({ a: z.custom(isStr), t: z.string().transform((s) => s.length) }),
        z.number(),
      ]);
    const compiled = jit(mk(), { eager: true });
    expect(compiled.safeParse({ a: "x", t: "abc" })).toEqual(mk().safeParse({ a: "x", t: "abc" }));
    expect(compiled.safeParse(5)).toEqual(mk().safeParse(5));
  });

  it("delegated issues keep zod's messages, error maps and key order", () => {
    // A delegated leaf is finalized by zod's own finalizeIssue: the check's
    // message, the schema's error map and the locale all resolve as they do in
    // safeParse, and the issue's keys come out in the same order.
    const mk = () =>
      z.object({
        d: z.date().refine((d) => d.getTime() > 0, { message: "epoch" }),
        s: z.string({ error: "need s" }).refine(() => true, { abort: true }),
        n: z.number().min(2, { error: (iss) => `min ${String(iss.minimum)}` }),
      });
    const compiled = jit(mk(), { eager: true });
    const input = { d: new Date(0), s: 1, n: 1 };
    const expected = mk().safeParse(input);
    const actual = compiled.safeParse(input);
    expect(actual.success).toBe(false);
    if (expected.success || actual.success) throw new Error("unreachable");
    expect(actual.error.issues).toEqual(expected.error.issues);
    expect(actual.error.message).toBe(expected.error.message);
  });
});
