/**
 * When does a container's `.refine()` still run after something inside it failed?
 *
 * Zod gates a schema's check chain on `util.aborted`: it skips the chain only
 * when an issue produced by that schema's own parse is NON-continuable. Every
 * issue a check produces is continuable (`$ZodCheck` sets `continue: !def.abort`,
 * and an `abort: true` check costs the schema its compiled path anyway), so the
 * split falls out by issue code:
 *
 *   continuable      too_small, too_big, invalid_format, not_multiple_of,
 *                    custom (a nested refine)          → outer refine STILL runs
 *   non-continuable  invalid_type, invalid_value, invalid_union,
 *                    unrecognized_keys, invalid_key,
 *                    invalid_element                    → outer refine suppressed
 *
 * Two ways to get this wrong, and the compiler had one of each: the object walk
 * gated its refines on "did anything fail at all", dropping the outer message
 * whenever a field failed its own `min()`; the array walk gated nothing, adding
 * an outer message zod never produces — and calling the user's predicate on data
 * zod never hands it.
 *
 * Size/length checks are exempt on both sides: zod's min/max/length checks
 * declare a `when` predicate, which bypasses the abort gate entirely, so
 * `z.array(z.string()).min(2)` reports too_small next to a bad element's
 * invalid_type.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

/** Issue `code@path` list from the compiled validator, forcing the deferred walk. */
function compiledIssues(schema: unknown, input: unknown, name: string): string[] {
  const result = compileLikeProduction(schema, name)(input);
  if (result.success) return [];
  return (result.error.issues as { code: string; path: unknown[] }[]).map(
    (issue) => `${issue.code}@${issue.path.join(".")}`,
  );
}

/**
 * The WHOLE issue list must match zod's, codes and paths and order.
 * `expectParity` compares only the first message, which is blind to a dropped or
 * an extra trailing issue — exactly the shape of this bug — so every case here
 * asserts the full list too.
 */
function expectIssueParity(schema: z.ZodType, input: unknown, name: string): void {
  const zodIssues = (schema.safeParse(input).error?.issues ?? []).map(
    (issue) => `${issue.code}@${issue.path.join(".")}`,
  );
  const described = JSON.stringify(input, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
  expect(compiledIssues(schema, input, name), `issue list for ${described}`).toStrictEqual(
    zodIssues,
  );
  expectParity(schema, [input], `${name}Msg`);
}

describe("refine gating — the reported regression", () => {
  it("reports an outer refine alongside a failing nested field check", () => {
    // Verbatim from the report: a nested `.min(1)` masked the outer message.
    const schema = z
      .object({ company: z.object({ description: z.string().min(1, "inner") }) })
      .refine((data) => Boolean(data?.company?.description), { error: "outer" });

    const result = compileLikeProduction(schema, "reported")({ company: { description: "" } });
    expect(result.success).toBe(false);
    const messages = (result.error.issues as { message?: string }[]).map((i) => i.message);
    expect(messages).toStrictEqual(["inner", "outer"]);
  });
});

describe("refine gating — a continuable inner failure keeps the outer refine", () => {
  it.each([
    ["too_small", z.object({ a: z.string().min(1, "inner") }), { a: "" }],
    ["too_big", z.object({ a: z.string().max(1, "inner") }), { a: "xy" }],
    ["invalid_format", z.object({ a: z.email("inner") }), { a: "nope" }],
    ["not_multiple_of", z.object({ a: z.number().multipleOf(3, "inner") }), { a: 4 }],
    ["bigint too_small", z.object({ a: z.bigint().min(5n, "inner") }), { a: 1n }],
    [
      "nested custom",
      z.object({ a: z.string().refine(() => false, { error: "inner" }) }),
      { a: "x" },
    ],
    ["array element too_small", z.object({ a: z.array(z.string().min(2, "inner")) }), { a: ["x"] }],
    [
      "deeply nested too_small",
      z.object({ n: z.object({ a: z.string().min(2, "inner") }) }),
      { n: { a: "x" } },
    ],
    // zod pushes unrecognized_keys with `continue: true`: it describes the
    // input's shape, not the parsed value, so the parse fails without aborting.
    [
      "unrecognized_keys (nested strict)",
      z.object({ a: z.strictObject({ b: z.string() }) }),
      { a: { b: "x", c: 1 } },
    ],
  ])("%s", (_label, base, input) => {
    const schema = (base as z.ZodObject).refine(() => false, { error: "outer" });
    expect(compiledIssues(schema, input, "keep")).toContain("custom@");
    expectIssueParity(schema, input, "keepParity");
  });
});

describe("refine gating — a non-continuable inner failure suppresses the outer refine", () => {
  it.each([
    ["invalid_type", z.object({ a: z.string() }), { a: 5 }],
    ["missing required key", z.object({ a: z.string() }), {}],
    ["invalid_value (enum)", z.object({ a: z.enum(["x"]) }), { a: "z" }],
    ["invalid_value (literal)", z.object({ a: z.literal("q") }), { a: "z" }],
    ["invalid_union", z.object({ a: z.union([z.string(), z.number()]) }), { a: true }],
    [
      "invalid_key (record)",
      z.object({ a: z.record(z.string().min(3), z.number()) }),
      { a: { xy: 1 } },
    ],
    ["nested object invalid_type", z.object({ a: z.object({ b: z.string() }) }), { a: 5 }],
    ["array element invalid_type", z.object({ a: z.array(z.string()) }), { a: [5] }],
  ])("%s", (_label, base, input) => {
    const predicate = vi.fn(() => false);
    const schema = (base as z.ZodObject).refine(predicate, { error: "outer" });
    expect(compiledIssues(schema, input, "drop")).not.toContain("custom@");
    // Suppressed means NOT CALLED, not merely "its issue was discarded" — a
    // predicate reaching into a field that failed to parse would throw.
    expect(predicate).not.toHaveBeenCalled();
    expectIssueParity(
      (base as z.ZodObject).refine(() => false, { error: "outer" }),
      input,
      "dropParity",
    );
  });

  it("the object's own unrecognized_keys pass still runs its refine", () => {
    const predicate = vi.fn(() => false);
    const schema = z.strictObject({ a: z.string() }).refine(predicate, { error: "outer" });
    expect(compiledIssues(schema, { a: "x", b: 1 }, "strictKeep")).toStrictEqual([
      "unrecognized_keys@",
      "custom@",
    ]);
    expect(predicate).toHaveBeenCalledTimes(1);
    expectIssueParity(schema, { a: "x", b: 1 }, "strictKeepParity");
  });

  it("a union does not count a strict option's unrecognized_keys as aborting", () => {
    // The strict object is the sole non-aborted option, so zod surfaces its own
    // issue directly instead of wrapping both options in an invalid_union.
    const schema = z.union([z.strictObject({ a: z.string() }), z.number()]);
    expect(compiledIssues(schema, { a: "x", b: 1 }, "strictUnion")).toStrictEqual([
      "unrecognized_keys@",
    ]);
    expectIssueParity(schema, { a: "x", b: 1 }, "strictUnionParity");
  });
});

describe("refine gating — arrays follow the same rule", () => {
  it("keeps the array's refine after a continuable element failure", () => {
    const schema = z.array(z.string().min(2, "inner")).refine(() => false, { error: "outer" });
    expect(compiledIssues(schema, ["x"], "arrKeep")).toStrictEqual(["too_small@0", "custom@"]);
    expectIssueParity(schema, ["x"], "arrKeepParity");
  });

  it.each([
    ["element invalid_type", z.array(z.string()), [5]],
    ["element invalid_value", z.array(z.enum(["a"])), ["z"]],
    ["element invalid_union", z.array(z.union([z.string(), z.number()])), [true]],
    ["element object property invalid_type", z.array(z.object({ a: z.number() })), [{ a: "x" }]],
  ])("suppresses the array's refine after %s", (_label, base, input) => {
    const predicate = vi.fn(() => false);
    const schema = (base as z.ZodArray).refine(predicate, { error: "outer" });
    expect(compiledIssues(schema, input, "arrDrop")).not.toContain("custom@");
    expect(predicate).not.toHaveBeenCalled();
    expectIssueParity(
      (base as z.ZodArray).refine(() => false, { error: "outer" }),
      input,
      "arrDropParity",
    );
  });

  it("keeps size checks ungated — zod's length checks declare a `when`", () => {
    // The element's invalid_type aborts the chain for the refine but NOT for
    // min(2), whose `when` predicate bypasses the gate.
    expectIssueParity(z.array(z.string()).min(2, "size"), [5], "sizeUngated");
    expect(compiledIssues(z.array(z.string()).min(2, "size"), [5], "sizeIssues")).toStrictEqual([
      "invalid_type@0",
      "too_small@",
    ]);
    const predicate = vi.fn(() => false);
    const schema = z.array(z.string()).min(2, "size").refine(predicate, { error: "outer" });
    expect(compiledIssues(schema, [5], "sizeAndRefine")).toStrictEqual([
      "invalid_type@0",
      "too_small@",
    ]);
    expect(predicate).not.toHaveBeenCalled();
  });
});

describe("refine gating — superRefine and multiple effects", () => {
  it("gates superRefine the same way", () => {
    const addOuter = (_v: unknown, ctx: { addIssue: (i: unknown) => void }): void => {
      ctx.addIssue({ code: "custom", message: "outer" });
    };
    // Continuable inner failure → superRefine still runs.
    expectIssueParity(
      z.object({ a: z.string().min(2, "inner") }).superRefine(addOuter),
      { a: "x" },
      "srKeep",
    );
    // Non-continuable → suppressed.
    expectIssueParity(z.object({ a: z.string() }).superRefine(addOuter), { a: 5 }, "srDrop");
    expectIssueParity(z.array(z.string()).superRefine(addOuter), [5], "srArrDrop");
    expectIssueParity(
      z.array(z.string().min(2, "inner")).superRefine(addOuter),
      ["x"],
      "srArrKeep",
    );
  });

  it("runs every outer refine after a continuable inner failure", () => {
    // A refine's own `custom` issue is continuable, so it never suppresses the
    // next one — zod recomputes its abort flag per check and it stays false.
    const schema = z
      .object({ a: z.string().min(1, "inner") })
      .refine(() => false, { error: "o1" })
      .refine(() => false, { error: "o2" });
    expectIssueParity(schema, { a: "" }, "multi");
    expect(compiledIssues(schema, { a: "" }, "multi2")).toStrictEqual([
      "too_small@a",
      "custom@",
      "custom@",
    ]);
  });
});

describe("refine gating — the predicate sees zod's payload", () => {
  it.each([
    ["stripped extra keys", z.object({ a: z.string().min(3) }), { a: "x", junk: 1 }],
    [
      "nested strip",
      z.object({ n: z.object({ a: z.string().min(3), b: z.number() }) }),
      { n: { a: "x", b: 1, junk: 2 }, junk: 3 },
    ],
    ["applied overwrite", z.object({ a: z.string().trim().min(1) }), { a: "  " }],
    ["applied default", z.object({ a: z.number().default(5), b: z.string().min(3) }), { b: "x" }],
  ])("hands the refine the same value as zod for %s", (_label, base, input) => {
    // The predicate now runs on inputs that failed a field check, so what it
    // RECEIVES is observable: it must be the parsed payload (stripped, with
    // defaults and rewrites applied), exactly as zod builds it.
    const seen: unknown[] = [];
    const spy = (value: unknown): boolean => {
      seen.push(structuredClone(value));
      return true;
    };
    const zodSeen: unknown[] = [];
    (base as z.ZodObject)
      .refine((v) => {
        zodSeen.push(structuredClone(v));
        return true;
      })
      .safeParse(input);

    const result = compileLikeProduction((base as z.ZodObject).refine(spy), "argParity")(input);
    if (!result.success) void result.error.issues;

    expect(seen).toStrictEqual(zodSeen);
    expect(seen).toHaveLength(1);
  });
});
