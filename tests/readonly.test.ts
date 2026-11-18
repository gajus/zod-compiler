import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { fastResultIsInput, rebuildsOutput } from "#src/core/codegen/build-path.js";
import { diagnoseSchema } from "#src/core/diagnostic.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { compileLikeProduction } from "./parity-harness.js";

const irOf = (schema: z.ZodType) => extractSchema(schema, []);

const clone = (value: unknown): unknown =>
  typeof value === "object" && value !== null ? structuredClone(value) : value;

/**
 * Verdict, data, issues, output frozen-ness, and what each side does to the
 * CALLER's input. Zod and the compiled validator each get their own clone, so
 * input mutation can be compared independently.
 *
 * The invariant is "matches Zod", not "never freezes": `z.date().readonly()`
 * hands back the caller's own Date, so Zod freezes it in place and the compiler
 * (delegating there) must too. The one place the two part company is a REJECTED
 * object input — pinned in known-divergences.test.ts.
 */
function assertParity(schema: z.ZodType, inputs: unknown[], label: string) {
  const compiled = compileLikeProduction(schema, "ro");
  for (const input of inputs) {
    const zodInput = clone(input);
    const aotInput = clone(input);
    const zodResult = schema.safeParse(zodInput);
    const aotResult = compiled(aotInput) as {
      success: boolean;
      data?: unknown;
      error?: { issues: unknown[] };
    };
    const tag = `${label} <- ${JSON.stringify(input)}`;

    expect(aotResult.success, tag).toBe(zodResult.success);
    if (zodResult.success && aotResult.success) {
      expect(aotResult.data, tag).toEqual(zodResult.data);
      expect(Object.isFrozen(aotResult.data), `${tag} (output frozen parity)`).toBe(
        Object.isFrozen(zodResult.data),
      );
      if (typeof input === "object" && input !== null) {
        expect(Object.isFrozen(aotInput), `${tag} (caller-input freeze parity)`).toBe(
          Object.isFrozen(zodInput),
        );
        expect(aotInput, `${tag} (caller input value)`).toEqual(zodInput);
      }
    } else if (!zodResult.success && !aotResult.success) {
      expect(JSON.stringify(aotResult.error?.issues), `${tag} (issues)`).toBe(
        JSON.stringify(zodResult.error?.issues),
      );
    }
  }
}

describe("readonly — an unobservable freeze compiles away", () => {
  const compiles: [string, z.ZodType][] = [
    ["string", z.string().readonly()],
    ["string with checks", z.string().min(2).readonly()],
    ["number", z.number().readonly()],
    ["int", z.int().readonly()],
    ["boolean", z.boolean().readonly()],
    ["bigint", z.bigint().readonly()],
    ["null", z.null().readonly()],
    ["undefined", z.undefined().readonly()],
    ["literal (primitive)", z.literal("a").readonly()],
    ["enum", z.enum(["a", "b"]).readonly()],
    ["template literal", z.templateLiteral(["a", z.string()]).readonly()],
    ["optional over primitive", z.string().optional().readonly()],
    ["nullable over primitive", z.string().nullable().readonly()],
    ["union of primitives", z.union([z.string(), z.number()]).readonly()],
    ["double readonly", z.string().readonly().readonly()],
  ];

  for (const [label, schema] of compiles) {
    it(`compiles: ${label}`, () => {
      const ir = irOf(schema);
      expect(ir.type, `${label} should not fall back`).toBe("readonly");
      expect(diagnoseSchema(ir).coveragePct, label).toBe(100);
    });
  }
});

describe("readonly — an observable freeze still delegates to Zod", () => {
  // Every container here is one the compiler hands back BY REFERENCE, so
  // freezing would freeze the caller's own data, and none is an array a
  // `slice()` could stand in for. z.date()/z.file() are objects in their own
  // right. Each keeps Zod's rebuild-then-freeze.
  const fallsBack: [string, z.ZodType][] = [
    ["strict object", z.strictObject({ a: z.string() }).readonly()],
    ["loose object", z.looseObject({ a: z.string() }).readonly()],
    ["record", z.record(z.string(), z.number()).readonly()],
    ["date", z.date().readonly()],
    ["map", z.map(z.string(), z.number()).readonly()],
    ["set", z.set(z.string()).readonly()],
    ["any", z.any().readonly()],
    ["unknown", z.unknown().readonly()],
    ["union containing an object", z.union([z.string(), z.object({ a: z.string() })]).readonly()],
    ["optional over object", z.object({ a: z.string() }).optional().readonly()],
    // Not looked through: the value may be `undefined`/`null`, with nothing to slice.
    ["optional over array", z.array(z.number()).optional().readonly()],
    ["nullable over array", z.array(z.number()).nullable().readonly()],
    ["union containing an array", z.union([z.string(), z.array(z.number())]).readonly()],
  ];

  for (const [label, schema] of fallsBack) {
    it(`falls back: ${label}`, () => {
      expect(irOf(schema).type, `${label} must keep delegating to Zod`).toBe("fallback");
    });
  }

  it("an .overwrite() callback can turn a primitive node into an object", () => {
    // The IR tag says "string", but the overwrite callback returns an object
    // that Zod's readonly then freezes — so the wrapper is NOT droppable.
    const schema = z
      .string()
      .overwrite((v) => ({ v }) as unknown as string)
      .readonly();
    expect(irOf(schema).type).toBe("fallback");

    const compiled = compileLikeProduction(schema, "roOverwrite");
    const zodResult = schema.safeParse("x") as { data: unknown };
    const aotResult = compiled("x") as { data: unknown };
    expect(aotResult.data).toEqual(zodResult.data);
    expect(Object.isFrozen(aotResult.data)).toBe(Object.isFrozen(zodResult.data));
  });

  it("a delegated readonly leaves no orphan ref-table entries", () => {
    // extractReadonly visits the inner subtree before it can tell whether the
    // freeze is observable; the discarded fallbacks' refs must be rolled back,
    // or __rf[] retains schemas the emitted code never reads.
    const inner = z.object({ a: z.string(), b: z.custom(() => true) });
    const withReadonly: RefEntry[] = [];
    extractSchema(inner.readonly(), withReadonly);
    const baseline: RefEntry[] = [];
    extractSchema(inner, baseline);
    expect(withReadonly.length).toBe(baseline.length);
  });
});

/**
 * An array or tuple under `.readonly()`.
 *
 * Zod parses it into a fresh array and freezes that. The compiled walks hand a
 * pass-through array back BY REFERENCE, so freezing what they return would
 * freeze the caller's own array — which is why these used to be delegated to
 * Zod whole, at Zod's speed. Two things make them compilable: an array whose
 * members rewrite is rebuilt by both walks anyway, and one whose members do not
 * is exactly reproduced by a shallow copy.
 */
describe("readonly — an array is frozen as Zod freezes it: a fresh one", () => {
  type ReadonlyShape = { type: string; freeze?: boolean; copy?: string; inner: { type: string } };

  it("copies an array the walks hand back by reference", () => {
    const shapes: [string, z.ZodType, string][] = [
      ["array of primitives", z.array(z.number()).readonly(), "array"],
      [
        "array of pass-through objects",
        z.array(z.strictObject({ a: z.string() })).readonly(),
        "array",
      ],
      ["array with checks", z.array(z.string()).min(1).max(3).readonly(), "array"],
      ["tuple", z.tuple([z.string(), z.number()]).readonly(), "tuple"],
      ["tuple with rest", z.tuple([z.string()]).rest(z.number()).readonly(), "tuple"],
    ];
    for (const [label, schema, inner] of shapes) {
      const ir = irOf(schema) as ReadonlyShape;
      expect(ir, label).toMatchObject({ type: "readonly", freeze: true, copy: "array" });
      expect(ir.inner.type, label).toBe(inner);
      expect(diagnoseSchema(ir as never).coveragePct, label).toBe(100);
    }
  });

  it("freezes in place an array both walks already rebuilt", () => {
    const shapes: [string, z.ZodType][] = [
      ["array of stripping objects", z.array(z.object({ a: z.string() })).readonly()],
      ["array of rewritten strings", z.array(z.string().trim()).readonly()],
      ["array of defaults", z.array(z.number().default(1)).readonly()],
      ["tuple with a rewriting item", z.tuple([z.string().trim(), z.number()]).readonly()],
      ["array of readonly arrays", z.array(z.array(z.number()).readonly()).readonly()],
    ];
    for (const [label, schema] of shapes) {
      const ir = irOf(schema) as ReadonlyShape;
      expect(ir, label).toMatchObject({ type: "readonly", freeze: true });
      expect(ir.copy, label).toBeUndefined();
    }
  });

  it("an outer readonly does not copy what an inner one already produced", () => {
    const ir = irOf(z.array(z.number()).readonly().readonly()) as ReadonlyShape;
    expect(ir).toMatchObject({
      type: "readonly",
      freeze: true,
      inner: { type: "readonly", freeze: true, copy: "array" },
    });
    expect(ir.copy).toBeUndefined();
  });

  it("withholds every by-reference shortcut", () => {
    for (const schema of [z.array(z.number()).readonly(), z.tuple([z.string()]).readonly()]) {
      const ir = irOf(schema);
      expect(rebuildsOutput(ir)).toBe(true);
      expect(fastResultIsInput(ir)).toBe(false);
    }
  });

  it("returns a frozen copy and leaves the caller's array exactly as it was", () => {
    const schema = z.array(z.number()).readonly();
    const compiled = compileLikeProduction(schema, "roArray");
    const input = [1, 2, 3];
    const result = compiled(input) as { success: boolean; data: number[] };

    expect(result.success).toBe(true);
    expect(result.data).toEqual([1, 2, 3]);
    expect(result.data).not.toBe(input);
    expect(Object.isFrozen(result.data)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    input.push(4);
    expect(result.data).toEqual([1, 2, 3]);
  });

  it("accepts an input that is itself frozen", () => {
    const schema = z.array(z.number()).readonly();
    const input = Object.freeze([1, 2]);
    const result = compileLikeProduction(schema, "roFrozenIn")(input) as { data: unknown };
    expect(result.data).toEqual(schema.parse(input));
    expect(Object.isFrozen(result.data)).toBe(true);
  });

  // Verdict, data, issues, frozen-ness of the output, and that the caller's
  // input is neither frozen nor changed — each against Zod, input by input.
  const PARITY: [string, z.ZodType, unknown[]][] = [
    [
      "array of numbers",
      z.array(z.number()).readonly(),
      [[1, 2], [], ["x"], [1, "x"], null, "no", {}],
    ],
    [
      "array with size checks and a refinement",
      z
        .array(z.string())
        .min(1)
        .max(2)
        .refine((values) => values[0] !== "no")
        .readonly(),
      [["a"], [], ["a", "b", "c"], ["no"], [1]],
    ],
    [
      "array of pass-through objects",
      z.array(z.strictObject({ a: z.string() })).readonly(),
      [[{ a: "x" }], [{ a: 1 }], [{ a: "x", b: 1 }], []],
    ],
    [
      "array of stripping objects",
      z.array(z.object({ a: z.string() })).readonly(),
      [[{ a: "x", extra: 1 }], [{ a: 1 }], [], "no"],
    ],
    ["array of anything", z.array(z.any()).readonly(), [[1, "a", null, undefined], [], 1]],
    [
      "tuple",
      z.tuple([z.string(), z.number()]).readonly(),
      [["a", 1], ["a"], [1, "a"], ["a", 1, 2], []],
    ],
    [
      "tuple with rest",
      z.tuple([z.string()]).rest(z.number()).readonly(),
      [["a"], ["a", 1, 2], ["a", "b"], []],
    ],
    [
      "tuple with an optional tail",
      z.tuple([z.string(), z.number().optional()]).readonly(),
      [["a"], ["a", 1], ["a", undefined], [1]],
    ],
    [
      "tuple that pads a short input",
      z.tuple([z.string(), z.number().default(7)]).readonly(),
      [["a"], ["a", 1], []],
    ],
    [
      "a field of a stripping object",
      z.object({ id: z.string(), tags: z.array(z.string()).readonly() }),
      [{ id: "a", tags: ["x"], extra: 1 }, { id: "a", tags: [1] }, { id: "a" }, {}],
    ],
    [
      "a field of a strict object",
      z.strictObject({ tags: z.array(z.string()).readonly() }),
      [{ tags: ["x"] }, { tags: ["x"], extra: 1 }, { tags: "x" }],
    ],
    [
      "a field of a loose object",
      z.looseObject({ tags: z.array(z.string()).readonly() }),
      [{ tags: ["x"], more: 1 }, { tags: [1] }],
    ],
    [
      "nested readonly arrays",
      z.array(z.array(z.number()).readonly()).readonly(),
      [[[1], [2, 3]], [[1], ["x"]], [1], []],
    ],
    [
      "an option of a union",
      z.union([z.string(), z.array(z.number()).readonly()]),
      ["a", [1], ["x"], 1],
    ],
    [
      "beside a field that keeps the schema on the eager walk",
      z.object({ xs: z.array(z.number()).readonly(), c: z.number().catch(0) }),
      [
        { xs: [1], c: "bad" },
        { xs: [1], c: 1 },
        { xs: ["x"], c: 1 },
      ],
    ],
    [
      "inside a record",
      z.record(z.string(), z.array(z.number()).readonly()),
      [{ a: [1], b: [] }, { a: ["x"] }],
    ],
    ["double readonly", z.array(z.number()).readonly().readonly(), [[1], ["x"]]],
  ];

  for (const [label, schema, inputs] of PARITY) {
    it(`matches Zod: ${label}`, () => assertParity(schema, inputs, label));
  }
});

describe("readonly — a stripping object freezes the value it rebuilt", () => {
  it("compiles with the freeze flag and matches Zod end to end", () => {
    const schema = z.object({ name: z.string() }).readonly();
    const ir = irOf(schema);
    expect(ir.type).toBe("readonly");
    expect((ir as { freeze?: boolean }).freeze).toBe(true);

    // Stripping still happens, the OUTPUT is frozen, and the caller's object —
    // which the compiler never had to touch, having rebuilt — stays mutable.
    const compiled = compileLikeProduction(schema, "roFreeze");
    const input = { name: "Alice", extra: 1 };
    const result = compiled(input) as { success: boolean; data: unknown };
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "Alice" });
    expect(Object.isFrozen(result.data)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(result.data).not.toBe(input);
  });

  it("withholds every by-reference shortcut", () => {
    // safeParse's `data:input` return and the `fc` behind parse()/~standard all
    // hand back the unfrozen input; a freezing readonly must disable them.
    const ir = irOf(z.object({ name: z.string() }).readonly());
    expect(rebuildsOutput(ir)).toBe(true);
    expect(fastResultIsInput(ir)).toBe(false);
  });

  it("freezes even when a sibling already pushed issues (relative mark)", () => {
    // `.catch()` lets the parse SUCCEED with a sibling's issues still in the
    // array, so the eager walk's freeze guard has to compare against a mark
    // taken before the inner ran, not against zero. An absolute test silently
    // skipped the freeze here while zod still applied it. Only the eager walk
    // is involved: mutatesBeyondStrip declines `.catch()`, so no build path.
    const inner = () => z.object({ a: z.string() }).readonly();
    const shapes: [string, z.ZodType, unknown, (data: never) => unknown][] = [
      [
        "object sibling",
        z.object({ bad: z.string(), r: inner() }).catch((c) => c.value as never),
        { bad: 1, r: { a: "x" } },
        (d) => (d as Record<string, unknown>)["r"],
      ],
      [
        "array element",
        z.array(inner()).catch((c) => c.value as never),
        [{ a: 1 }, { a: "x" }],
        (d) => (d as unknown[])[1],
      ],
      [
        "tuple slot",
        z.tuple([z.string(), inner()]).catch((c) => c.value as never),
        [1, { a: "x" }],
        (d) => (d as unknown[])[1],
      ],
    ];

    for (const [label, schema, input, pick] of shapes) {
      const compiled = compileLikeProduction(schema, "roMark");
      type Result = { success: boolean; data: never };
      const zodResult = schema.safeParse(structuredClone(input)) as Result;
      const aotResult = compiled(structuredClone(input)) as Result;
      expect(aotResult.success, label).toBe(zodResult.success);
      expect(Object.isFrozen(pick(aotResult.data)), label).toBe(
        Object.isFrozen(pick(zodResult.data)),
      );
    }
  });

  it("freezes through nesting, arrays and unions", () => {
    const cases: [string, z.ZodType, unknown][] = [
      [
        "nested",
        z.object({ inner: z.object({ a: z.string() }).readonly() }),
        { inner: { a: "x" } },
      ],
      ["in array", z.array(z.object({ a: z.string() }).readonly()), [{ a: "x" }]],
      ["double readonly", z.object({ a: z.string() }).readonly().readonly(), { a: "x" }],
      ["in union", z.union([z.string(), z.object({ a: z.string() }).readonly()]), { a: "x" }],
    ];
    // Reach past the wrapper to the object the freeze should have landed on.
    const pick = (label: string, data: unknown): unknown => {
      const record = data as Record<string, unknown>;
      if (label === "nested") return record["inner"];
      if (label === "in array") return (data as unknown[])[0];
      return data;
    };

    for (const [label, schema, input] of cases) {
      const compiled = compileLikeProduction(schema, "roNest");
      const zodResult = schema.safeParse(structuredClone(input)) as { data: unknown };
      const aotResult = compiled(structuredClone(input)) as { data: unknown };
      expect(aotResult.data, label).toEqual(zodResult.data);
      expect(Object.isFrozen(pick(label, aotResult.data)), label).toBe(
        Object.isFrozen(pick(label, zodResult.data)),
      );
    }
  });
});

describe("readonly — parity with Zod", () => {
  it("primitive readonly", () => {
    assertParity(z.string().readonly(), ["hello", "", 42, null, undefined], "string");
    assertParity(z.string().min(2).readonly(), ["ab", "a", 7], "string.min");
    assertParity(z.number().readonly(), [1, Number.NaN, Infinity, "1", null], "number");
    assertParity(z.enum(["a", "b"]).readonly(), ["a", "c", 1, null], "enum");
    assertParity(z.literal("a").readonly(), ["a", "b", null], "literal");
  });

  it("readonly nested in an object (the issue's mySchema2)", () => {
    assertParity(
      z.object({ foo: z.string().readonly(), bar: z.array(z.int()) }),
      [
        { foo: "hi", bar: [1, 2] },
        { foo: 1, bar: [1] },
        { foo: "hi", bar: ["x"] },
        { foo: "hi", bar: [1], extra: "stripped" },
        {},
        null,
      ],
      "mySchema2",
    );
  });

  it("readonly wrappers over optional/nullable/union", () => {
    assertParity(z.string().optional().readonly(), ["a", undefined, 1], "optional");
    assertParity(z.string().nullable().readonly(), ["a", null, 1], "nullable");
    assertParity(z.union([z.string(), z.number()]).readonly(), ["a", 1, true], "union");
  });

  it("container readonly matches Zod, compiled or delegated", () => {
    assertParity(
      z.object({ name: z.string() }).readonly(),
      [{ name: "Alice" }, {}, null, "not object"],
      "object",
    );
    assertParity(z.array(z.number()).readonly(), [[1, 2], ["x"], null], "array");
    assertParity(z.date().readonly(), [new Date(0), "nope"], "date");
  });

  it("a readonly field no longer forces the whole object off the fast path", () => {
    const before = diagnoseSchema(irOf(z.object({ foo: z.string(), bar: z.array(z.int()) })));
    const after = diagnoseSchema(
      irOf(z.object({ foo: z.string().readonly(), bar: z.array(z.int()) })),
    );
    expect(after.coveragePct).toBe(before.coveragePct);
    expect(after.coveragePct).toBe(100);
    expect(after.fastPathEligible).toBe(true);
    expect(after.fallbacks).toEqual([]);
  });

  it("a readonly root object now compiles (the issue's mySchema3)", () => {
    const ir = irOf(z.object({ foo: z.string() }).readonly());
    expect(ir.type).toBe("readonly");
    expect((ir as { freeze?: boolean }).freeze).toBe(true);
    const d = diagnoseSchema(ir);
    expect(d.coveragePct).toBe(100);
    expect(d.fallbacks).toEqual([]);
  });

  it("a delegated readonly explains itself instead of claiming to be unsupported", () => {
    // The generic "not yet supported" hint reads as an oversight; delegating a
    // pass-through container is a deliberate trade-off, so it gets its own reason.
    const d = diagnoseSchema(irOf(z.record(z.string(), z.string()).readonly()));
    expect(d.fallbacks[0]?.reason).toBe("readonly");
    expect(d.fallbacks[0]?.hint).toContain("caller's own input");
    expect(d.fastPathBlocker).toBe("fallback (readonly)");
  });
});
