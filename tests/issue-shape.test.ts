/**
 * Where an issue is reported, and what a nested one looks like.
 *
 * Three shipped bugs lived here, all invisible to a green suite because
 * `expectParity` compared only the first message and never a path:
 *
 *   set    an invented `[index]` segment. Zod's handleSetResult pushes element
 *          issues UNPREFIXED — a Set has no positional addressing — so they
 *          report at the set's own path.
 *   map    `[index, "key"]` / `[index, "value"]`. Zod addresses an entry BY ITS
 *          KEY when that key is a property-key type, and otherwise wraps the
 *          issues in `invalid_key` / `invalid_element`. The branch is chosen on
 *          the key's RUNTIME type, not the key schema's.
 *   number a `.int()` failure reports `invalid_type` — non-continuable — so zod
 *          skips every check after it. An ungated chain volunteered extra
 *          too_small/too_big/not_multiple_of issues alongside it.
 *
 * And one shape bug found alongside them: issues nested inside an
 * `invalid_key` / `invalid_element` wrapper never reach the top-level
 * finalization loop, so zod finalizes them where it builds the wrapper. The
 * record walk nested them raw, leaking absolute paths and the raw `input`.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

/** The emitted preamble + validator body, for asserting on generated shape. */
function slowWalkOf(schema: unknown): string {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const result = generateValidator(ir, "g", { refCount: refEntries.length });
  return `${result.code}\n${result.functionDef}`;
}

/** Compiled issues reduced to what these cases are about, forcing the deferred walk. */
function issuesOf(schema: unknown, input: unknown, name: string): unknown[] {
  const result = compileLikeProduction(schema, name)(input);
  if (result.success) return [];
  return (result.error.issues as Record<string, unknown>[]).map((issue) => {
    const out: Record<string, unknown> = { code: issue["code"], path: issue["path"] };
    if (issue["key"] !== undefined) out["key"] = issue["key"];
    if (issue["origin"] !== undefined) out["origin"] = issue["origin"];
    if (issue["issues"] !== undefined) {
      out["issues"] = (issue["issues"] as Record<string, unknown>[]).map((nested) => ({
        code: nested["code"],
        path: nested["path"],
        message: nested["message"],
        hasInput: "input" in nested && nested["input"] !== undefined,
      }));
    }
    return out;
  });
}

describe("issue shape — set elements report at the set's own path", () => {
  it("carries no index segment", () => {
    expect(issuesOf(z.set(z.string()), new Set([5]), "s1")).toStrictEqual([
      { code: "invalid_type", path: [] },
    ]);
    expectParity(z.set(z.string()), [new Set([5])], "s1p");
  });

  it("reports two bad elements at the same path", () => {
    // Zod's real output: no index means the two issues are indistinguishable by
    // path. Inventing indices to disambiguate them pointed at nothing zod does.
    expect(issuesOf(z.set(z.string()), new Set(["a", 5, 6]), "s2")).toStrictEqual([
      { code: "invalid_type", path: [] },
      { code: "invalid_type", path: [] },
    ]);
  });

  it("keeps the element's own relative path below the set", () => {
    expect(issuesOf(z.set(z.object({ a: z.string() })), new Set([{ a: 1 }]), "s3")).toStrictEqual([
      { code: "invalid_type", path: ["a"] },
    ]);
  });

  it("roots the element path at the set's position in the parent", () => {
    expect(issuesOf(z.object({ s: z.set(z.string()) }), { s: new Set([5]) }, "s4")).toStrictEqual([
      { code: "invalid_type", path: ["s"] },
    ]);
    expectParity(z.object({ s: z.set(z.string()) }), [{ s: new Set([5]) }], "s4p");
  });

  it("still reports a size check at the set's path", () => {
    expectParity(z.set(z.string()).min(2, "size"), [new Set([5]), new Set(["a"])], "s5");
  });
});

describe("issue shape — map entries are addressed by key", () => {
  it("prefixes key and value issues with a string key", () => {
    expect(issuesOf(z.map(z.string(), z.number()), new Map([["a", "x"]]), "m1")).toStrictEqual([
      { code: "invalid_type", path: ["a"] },
    ]);
    expect(
      issuesOf(z.map(z.string().min(3, "k"), z.number()), new Map([["x", "y"]]), "m2"),
    ).toStrictEqual([
      { code: "too_small", origin: "string", path: ["x"] },
      { code: "invalid_type", path: ["x"] },
    ]);
  });

  it("uses the key's RUNTIME type, not the key schema's", () => {
    // A number key under z.map(z.string(), …) is still a property-key type, so
    // it addresses the entry even though it fails the key schema.
    expect(issuesOf(z.map(z.string(), z.number()), new Map([[5, 1]]) as never, "m3")).toStrictEqual(
      [{ code: "invalid_type", path: [5] }],
    );
    // And a string key under z.map(z.boolean(), …) likewise.
    expect(
      issuesOf(z.map(z.boolean(), z.string()), new Map([["x", "a"]]) as never, "m4"),
    ).toStrictEqual([{ code: "invalid_type", path: ["x"] }]);
  });

  it("wraps a non-property-key entry's key issues in invalid_key", () => {
    expect(
      issuesOf(
        z.map(z.object({ a: z.string() }), z.string()),
        new Map([[{ a: 1 }, "v"]]) as never,
        "m5",
      ),
    ).toStrictEqual([
      {
        code: "invalid_key",
        origin: "map",
        path: [],
        issues: [
          {
            code: "invalid_type",
            path: ["a"],
            message: "Invalid input: expected string, received number",
            hasInput: false,
          },
        ],
      },
    ]);
  });

  it("wraps a non-property-key entry's value issues in invalid_element with the key", () => {
    expect(
      issuesOf(z.map(z.boolean(), z.string()), new Map([[true, 5]]) as never, "m6"),
    ).toStrictEqual([
      {
        code: "invalid_element",
        origin: "map",
        key: true,
        path: [],
        issues: [
          {
            code: "invalid_type",
            path: [],
            message: "Invalid input: expected string, received number",
            hasInput: false,
          },
        ],
      },
    ]);
  });

  it("roots entry paths at the map's position in the parent", () => {
    expect(
      issuesOf(z.object({ m: z.map(z.string(), z.number()) }), { m: new Map([["a", "x"]]) }, "m7"),
    ).toStrictEqual([{ code: "invalid_type", path: ["m", "a"] }]);
  });

  it("addresses the RIGHT entry in a multi-entry map", () => {
    expect(
      issuesOf(
        z.map(z.string(), z.number()),
        new Map([
          ["a", 1],
          ["b", "x"],
          ["c", 2],
        ]) as never,
        "m8",
      ),
    ).toStrictEqual([{ code: "invalid_type", path: ["b"] }]);
  });

  it.each([
    ["symbol key", z.map(z.symbol(), z.string()), new Map([[Symbol("s"), 5]])],
    ["bigint key", z.map(z.bigint(), z.string()), new Map([[1n, 5]])],
    ["date key", z.map(z.date(), z.string()), new Map([[new Date(0), 5]])],
    ["object key", z.map(z.object({ k: z.string() }), z.string()), new Map([[{ k: "v" }, 5]])],
    ["number key", z.map(z.number(), z.string()), new Map([[1, 5]])],
  ])("matches zod for a %s", (_label, schema, input) => {
    expectParity(schema as never, [input], "mk");
  });

  it("applies a mutating key schema and still reports against the ORIGINAL key", () => {
    expectParity(z.map(z.string().trim(), z.number()), [new Map([[" a ", 1]])], "m9");
    expectParity(z.map(z.string().trim().min(3, "k"), z.number()), [new Map([[" a ", 1]])], "m10");
  });
});

describe("issue shape — a failed integer format stops the rest of the chain", () => {
  it("reports the int failure alone", () => {
    expect(issuesOf(z.number().int("f").min(5, "a"), 1.5, "f1")).toStrictEqual([
      { code: "invalid_type", path: [] },
    ]);
    expectParity(z.number().int("f").min(5, "a"), [1.5, 1, 7], "f1p");
  });

  it.each([
    [
      "int + min + max + multipleOf",
      z.number().int("f").min(5, "a").max(1, "b").multipleOf(3, "c"),
    ],
    [
      "int + refine",
      z
        .number()
        .int("f")
        .refine(() => false, "r"),
    ],
    ["uint32 + min", z.uint32("f").min(5, "a")],
    ["int32 + min", z.int32("f").min(5, "a")],
  ])("%s", (_label, schema) => {
    expectParity(schema as never, [1.5, 1, 3], "f2");
  });

  it("leaves the chain alone when the format check passes", () => {
    // An integer outside the safe range reports CONTINUABLE too_small/too_big,
    // so later checks still run — the guard is `Number.isInteger`, not "did the
    // format check fail".
    expectParity(z.number().int("f").min(5, "a"), [1, 7], "f3");
    expectParity(z.int32("f").min(5, "a"), [3e9, 1], "f4");
  });

  it("does not gate checks BEFORE the format check", () => {
    // min runs first and its too_small is continuable, so the int failure that
    // follows is still reported.
    expectParity(z.number().min(5, "a").int("f"), [1.5], "f5");
    expectParity(z.number().multipleOf(3, "m").int("f"), [4.5], "f6");
  });

  it("emits the guard only when checks follow the format check", () => {
    // The guard costs bytes and a Number.isInteger call, so it is opened lazily:
    // present when something follows the int check, absent when nothing does.
    expect(slowWalkOf(z.number().int("f").min(5, "a"))).toContain("Number.isInteger");
    expect(slowWalkOf(z.number().min(5, "a").int("f"))).not.toContain(`if(Number.isInteger(_d)){`);
    expect(slowWalkOf(z.number().min(5, "a"))).not.toContain("Number.isInteger");
    expectParity(z.number().min(5, "a").int("f"), [1.5, 7], "f7");
  });

  it("float formats never gate — they cannot report invalid_type", () => {
    expectParity(z.float32("f").min(5, "a"), [1, 1e39], "f8");
  });
});

describe("issue shape — nested issues inside a wrapper are finalized", () => {
  it("gives a record's invalid_key relative paths, a message, and no input", () => {
    expect(issuesOf(z.record(z.string().min(3, "k"), z.number()), { xy: 1 }, "r1")).toStrictEqual([
      {
        code: "invalid_key",
        origin: "record",
        path: ["xy"],
        issues: [{ code: "too_small", path: [], message: "k", hasInput: false }],
      },
    ]);
    expectParity(z.record(z.string().min(3, "k"), z.number()), [{ xy: 1 }, { xyz: 1 }], "r1p");
  });

  it("applies the locale default to a nested issue with no baked message", () => {
    const [issue] = issuesOf(z.record(z.uuid(), z.number()), { nope: 1 }, "r2") as [
      { issues: { message?: string }[] },
    ];
    expect(issue.issues[0]?.message).toBe("Invalid UUID");
  });

  it("keeps a nested object key's own relative path", () => {
    expectParity(
      z.map(z.object({ a: z.string() }), z.string()),
      [new Map([[{ a: 1 }, "v"]]) as never],
      "r3",
    );
  });
});

describe("issue shape — containers nested in each other", () => {
  it.each([
    ["array of sets", z.array(z.set(z.string())), [[new Set([5])]]],
    ["set of sets", z.set(z.set(z.string())), [new Set([new Set([5])])]],
    ["map of sets", z.map(z.string(), z.set(z.string())), [new Map([["k", new Set([5])]])]],
    ["set of maps", z.set(z.map(z.string(), z.number())), [new Set([new Map([["a", "x"]])])]],
    [
      "map of maps",
      z.map(z.string(), z.map(z.string(), z.number())),
      [new Map([["o", new Map([["i", "x"]])]])],
    ],
    ["record of sets", z.record(z.string(), z.set(z.string())), [{ r: new Set([5]) }]],
    [
      "tuple of both",
      z.tuple([z.set(z.string()), z.map(z.string(), z.number())]),
      [[new Set([5]), new Map([["a", "x"]])]],
    ],
    ["union with a set", z.union([z.set(z.string()), z.number()]), [new Set([5]), true]],
    ["optional set", z.set(z.string()).optional(), [new Set([5])]],
    ["set with a refine", z.set(z.string()).refine((s) => s.size > 1, "small"), [new Set([5])]],
    [
      "int inside a map value",
      z.map(z.string(), z.number().int("f").min(5, "a")),
      [new Map([["k", 1.5]])],
    ],
    ["int inside a set", z.set(z.number().int("f").min(5, "a")), [new Set([1.5])]],
  ])("%s", (_label, schema, inputs) => {
    expectParity(schema as never, inputs as unknown[], "nest");
  });
});

/**
 * `.refine(fn, { params })` — the fourth field of a custom issue.
 *
 * $ZodCustom's check writes `if (def.params) _iss.params = def.params`, so the
 * key exists only when the schema declared one and holds the ORIGINAL object,
 * shared by every issue the check raises. The compiler dropped it entirely:
 * invisible to a suite that compared code, path, and one message, and the whole
 * point of passing params is that an error map reads them back.
 *
 * Identity is asserted alongside the shape because a structural comparison
 * cannot see the difference between zod's shared object and a per-failure copy.
 */
describe("issue shape — a refine's params reach the issue", () => {
  const params = { code: "E_SHORT", limit: 3 };

  it.each([
    ["string", z.string().refine((v) => v.length > 3, { params }), "a"],
    ["number", z.number().refine((v) => v > 3, { params }), 1],
    ["array", z.array(z.string()).refine((v) => v.length > 3, { params }), []],
    ["object", z.object({ a: z.string() }).refine((v) => v.a.length > 3, { params }), { a: "x" }],
    ["with a message", z.string().refine(() => false, { message: "m", params }), "a"],
    [
      "with a path",
      z.object({ a: z.string() }).refine(() => false, { path: ["a"], params }),
      {
        a: "x",
      },
    ],
    // The predicate captures `params`, so it cannot be inlined — the refine is
    // called through __rf[] instead, a different emit path with the same duty.
    ["captured predicate", z.string().refine((v) => v.length > params.limit, { params }), "a"],
  ])("%s", (label, schema, input) => {
    // The name becomes a JS identifier in the generated source.
    expectParity(schema as never, [input], `params_${label.replaceAll(" ", "_")}`);
  });

  it("carries zod's OWN params object, not a per-failure copy", () => {
    const schema = z.string().refine(() => false, { params });
    const compiled = compileLikeProduction(schema, "paramsIdentity");
    const first = compiled("a");
    const second = compiled("b");
    if (first.success || second.success) throw new Error("expected both parses to fail");
    const issueParams = (issues: unknown[]) => (issues[0] as { params?: unknown }).params;
    expect(issueParams(first.error.issues)).toBe(params);
    expect(issueParams(second.error.issues)).toBe(params);
    expect(issueParams(schema.safeParse("a").error?.issues ?? [])).toBe(params);
  });

  it("parks params on __rf under an access path that resolves from the schema", () => {
    // generateIIFE materializes `__rf` by navigating each accessPath from the
    // schema root, so a wrong path is a TypeError in every emitted file — and
    // compileLikeProduction, which uses the collected VALUES, would not see it.
    const refEntries: RefEntry[] = [];
    extractSchema(
      z.string().refine(() => false, { params }),
      refEntries,
    );
    const entry = refEntries.find((ref) => ref.schema === params);
    expect(entry?.accessPath).toBe("._zod.def.checks[0]._zod.def.params");
    const navigate = new Function("s", `return s${entry?.accessPath ?? ""};`);
    expect(navigate(z.string().refine(() => false, { params }))).toBe(params);
  });

  it("leaves the key OFF when the refine declares no params", () => {
    const compiled = compileLikeProduction(
      z.string().refine(() => false),
      "noParams",
    );
    const result = compiled("a");
    if (result.success) throw new Error("expected a failure");
    expect("params" in (result.error.issues[0] as object)).toBe(false);
  });
});

/**
 * ISSUE KEY ORDER.
 *
 * `ZodError`'s `message` is `JSON.stringify(issues, …, 2)`, so the order each
 * issue's keys were INSERTED in is printed text in a property consumers log,
 * snapshot, and serialize. `toStrictEqual` compares objects key-order-
 * insensitively, so a compiled issue carrying exactly the right fields in a
 * different order passed every other assertion in the suite while rendering a
 * different error than zod for essentially every failure.
 *
 * zod's own orders are irregular and follow whichever `payload.issues.push({…})`
 * raised the issue: `{expected, code}` for every schema except a discriminated
 * union's `{code, expected}`; `origin` leading a check's `too_small` and
 * trailing a tuple's; `expected, format, code` for an integer-format failure
 * against `expected, code, received` for a NaN. `finalizeIssue` then appends
 * `message` last, even for a message baked into a custom error map.
 *
 * `expectParity` compares `error.message` on every case in the suite, which is
 * what holds this in general; the cases below name the shapes whose order was
 * wrong, so a regression reports as itself rather than as a distant failure.
 */
describe("issue shape — key order, as ZodError.message renders it", () => {
  const orderOf = (issue: unknown): string[] => Object.keys(issue as object);

  const expectKeyOrder = (schema: z.ZodType, input: unknown): void => {
    const zodIssues = schema.safeParse(input).error?.issues ?? [];
    const compiled = compileLikeProduction(schema, "keyOrder");
    const result = compiled(input) as { success: false; error: { issues: unknown[] } };
    expect(zodIssues.length, "precondition: zod rejects this input").toBeGreaterThan(0);
    expect(result.error.issues.map(orderOf)).toStrictEqual(zodIssues.map(orderOf));
  };

  const CASES: [label: string, schema: z.ZodType, input: unknown][] = [
    ["invalid_type leads with `expected`", z.string(), 1],
    ["invalid_type with `received`", z.number(), null],
    ["invalid_type from an integer format leads `expected, format`", z.int(), 1.5],
    [
      "invalid_type from a discriminated union leads with `code`",
      z.discriminatedUnion("t", [z.object({ t: z.literal("a") })]),
      1,
    ],
    ["too_small from a check leads with `origin`", z.string().min(3), "a"],
    ["too_big from a check leads with `origin`", z.string().max(1), "abc"],
    ["exact length leads with `origin`", z.string().length(2), "a"],
    ["too_big from a tuple trails `origin` after `inclusive`", z.tuple([z.string()]), ["a", "b"]],
    [
      "too_small from a tuple trails `origin` after `inclusive`",
      z.tuple([z.string(), z.number()]),
      [],
    ],
    ["invalid_type for an absent required key leads with `code`", z.object({ a: z.any() }), {}],
    ["safe-integer overflow puts `note` before `origin`", z.int(), Number.MAX_SAFE_INTEGER + 2],
    ["not_multiple_of leads with `origin`", z.number().multipleOf(3), 5],
    ["not_multiple_of on a bigint", z.bigint().multipleOf(3n), 5n],
    ["invalid_format from a pattern check leads with `origin`", z.string().regex(/^a/), "b"],
    ["invalid_format includes", z.string().includes("q"), "b"],
    ["invalid_format starts_with", z.string().startsWith("q"), "b"],
    ["invalid_format ends_with", z.string().endsWith("q"), "b"],
    ["invalid_format from z.url() carries no `origin`", z.httpUrl(), "ftp://a.com"],
    ["invalid_value from stringbool puts `expected` before `values`", z.stringbool(), "maybe"],
    ["invalid_key puts `issues` before `path`", z.record(z.string().min(3), z.number()), { ab: 1 }],
    [
      "invalid_element leads with `origin`",
      z.map(z.object({ a: z.string() }), z.number()),
      new Map([[{ a: "x" }, "bad"]]),
    ],
    ["a baked custom message still lands LAST", z.string().min(3, "custom!"), "a"],
    ["a schema-level message still lands LAST", z.string({ error: "bad type" }), 1],
  ];

  for (const [label, schema, input] of CASES) {
    it(label, () => expectKeyOrder(schema, input));
  }

  it("nested issues inside invalid_key and invalid_union follow the same orders", () => {
    expectKeyOrder(z.record(z.string().min(3), z.number()), { ab: 1 });
    expectKeyOrder(z.union([z.string().min(3), z.number()]), true);
    expectKeyOrder(z.object({ u: z.union([z.string().min(3), z.number()]) }), { u: "a" });
  });
});
