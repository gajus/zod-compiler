/**
 * A compiled parse never writes to the caller's data (#21).
 *
 * The slow walk validated an array element, a tuple slot and a record value IN
 * PLACE: each member was visited with the container's own slot (`input[i]`) as
 * both its input and its output, so every node that writes its output back
 * wrote into the caller's container. A pass-through loose object, a record and
 * a tuple do that on every parse, so:
 *
 *   - a frozen input (`Object.freeze`, Immer or Redux state) made `safeParse`
 *     THROW "Cannot assign to read only property" in strict code — every ES
 *     module bundle — on valid input, and on invalid input as soon as the
 *     deferred walk behind `.error` ran;
 *   - an ordinary input had a replacement swapped into it: a
 *     `__proto__`-scrubbed copy, or a recursive member rebuilt by its own
 *     validator;
 *   - under `z.preprocess()`, a rewriting array wrote the rewritten elements
 *     into the caller's array and returned the original ones.
 *
 * The harness compiles strict, like the modules generated code ships inside.
 * `jit()` evaluates through sloppy `new Function`, which drops the failed write
 * silently instead.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import type { SafeParseSuccess } from "#src/core/types.js";
import { compileLikeProduction, expectLeanParity, expectParity } from "./parity-harness.js";

/** Freeze a JSON-shaped value and everything under it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

const dataOf = <T>(result: { success: boolean }): T => (result as SafeParseSuccess<T>).data;

/** An object with an own `__proto__` key, as `JSON.parse` creates one. */
const withProto = (): Record<string, unknown> =>
  JSON.parse('{"id":"a","__proto__":{"polluted":true}}') as Record<string, unknown>;

/** Hands back its input, so a member of this schema writes its output on every parse. */
const member = () => z.looseObject({ id: z.string() });

/**
 * Recursive, with a `.catch()` that keeps it off the build path, so the eager
 * walk produces the output — and each child is rebuilt (stripped) by the
 * recursive validator rather than by the array holding it.
 */
const Node: z.ZodType = z.object({
  id: z.string().catch("?"),
  kids: z.array(z.lazy(() => Node)),
});

describe("a frozen input parses like zod instead of throwing", () => {
  it("the reported schema: a loose object holding an array of passthrough objects", () => {
    const schema = z
      .object({
        p: z.number(),
        items: z.array(z.object({ id: z.string() }).passthrough()),
      })
      .passthrough();
    const inputs = [
      { p: 1, items: [{ id: "a", extra: 1 }] },
      { p: 1, items: [{ id: "a" }, { id: 2 }] },
      { p: "x", items: [] },
    ].map(deepFreeze);
    expectParity(schema, inputs, "frozenReported");
    expectParity(schema, inputs, "frozenReportedCompact", undefined, { compact: true });
    expectLeanParity(schema, inputs, "frozenReportedLean");
  });

  const cases: [name: string, label: string, schema: z.ZodType, inputs: unknown[]][] = [
    [
      "frozenRecord",
      "record value",
      z.record(z.string(), member()),
      [{ k: { id: "a" } }, { k: { id: 1 } }],
    ],
    [
      "frozenRootArray",
      "array element, where invalid input reaches the walk through `.error`",
      z.array(member()),
      [[{ id: "a" }], [{ id: "a" }, { id: 1 }]],
    ],
    [
      "frozenRootTuple",
      "tuple item, where invalid input reaches the walk through `.error`",
      z.tuple([member(), member()]),
      [
        [{ id: "a" }, { id: "b" }],
        [{ id: "a" }, { id: 1 }],
      ],
    ],
    [
      "frozenTupleItem",
      "tuple item",
      z.looseObject({ t: z.tuple([member()]) }),
      [{ t: [{ id: "a" }] }, { t: [{ id: 1 }] }],
    ],
    [
      "frozenTupleRest",
      "tuple rest element",
      z.looseObject({ t: z.tuple([z.string()]).rest(member()) }),
      [{ t: ["x", { id: "a" }, { id: "b" }] }, { t: ["x", { id: 1 }] }],
    ],
    [
      "frozenArrayOfRecords",
      "array of records",
      z.looseObject({ a: z.array(z.record(z.string(), z.number())) }),
      [{ a: [{ x: 1 }] }, { a: [{ x: "1" }] }],
    ],
    [
      "frozenNestedArrays",
      "nested arrays",
      z.looseObject({ a: z.array(z.array(member())) }),
      [{ a: [[{ id: "a" }]] }, { a: [[{ id: 1 }]] }],
    ],
    [
      "frozenRecordOfArrays",
      "record of arrays",
      z.looseObject({ r: z.record(z.string(), z.array(member())) }),
      [{ r: { k: [{ id: "a" }] } }, { r: { k: [{ id: 1 }] } }],
    ],
    [
      "frozenWrappedElements",
      "elements behind optional and nullable",
      z.looseObject({ a: z.array(member().optional()), b: z.array(member().nullable()) }),
      [{ a: [{ id: "a" }, undefined], b: [null, { id: "b" }] }],
    ],
    [
      "frozenUnionElement",
      "union element",
      z.looseObject({ a: z.array(z.union([member(), z.string()])) }),
      [{ a: [{ id: "a" }, "s"] }, { a: [1] }],
    ],
    [
      "frozenIntersectionElement",
      "intersection element",
      z.looseObject({ a: z.array(z.intersection(member(), z.looseObject({ b: z.string() }))) }),
      [{ a: [{ id: "a", b: "b" }] }, { a: [{ id: "a" }] }],
    ],
    [
      "frozenRecursive",
      "recursive members",
      Node,
      [
        { id: "a", kids: [{ id: "b", kids: [], extra: 1 }] },
        { id: "a", kids: [{ id: 1, kids: [] }] },
      ],
    ],
  ];

  for (const [name, label, schema, inputs] of cases) {
    it(label, () => {
      expectParity(schema, inputs.map(deepFreeze), name);
    });
  }

  it("lean output agrees", () => {
    const schema = z.looseObject({
      a: z.array(member()),
      r: z.record(z.string(), member()),
      t: z.tuple([member()]).rest(member()),
    });
    expectLeanParity(
      schema,
      [
        { a: [{ id: "a" }], r: { k: { id: "b" } }, t: [{ id: "c" }, { id: "d" }] },
        { a: [{ id: 1 }], r: { k: { id: 2 } }, t: [{ id: 3 }] },
      ].map(deepFreeze),
      "frozenLean",
    );
  });
});

describe("a member's replacement lands on a copy, never on the caller's container", () => {
  it("array element", () => {
    const schema = z.looseObject({ items: z.array(member()) });
    const compiled = compileLikeProduction(schema, "replaceArrayElement");
    const input = { items: [withProto(), { id: "b" }] };
    const [first] = input.items;
    const data = dataOf<{ items: object[] }>(compiled(input));
    expect(input.items[0]).toBe(first);
    expect(Object.hasOwn(input.items[0] as object, "__proto__")).toBe(true);
    expect(data.items).not.toBe(input.items);
    expect(Object.hasOwn(data.items[0] as object, "__proto__")).toBe(false);
    expect(data).toStrictEqual(dataOf(schema.safeParse({ items: [withProto(), { id: "b" }] })));
  });

  it("record value", () => {
    const schema = z.record(z.string(), member());
    const compiled = compileLikeProduction(schema, "replaceRecordValue");
    const input = { k: withProto(), j: { id: "b" } };
    const first = input.k;
    const data = dataOf<Record<string, object>>(compiled(input));
    expect(input.k).toBe(first);
    expect(Object.hasOwn(input.k, "__proto__")).toBe(true);
    expect(data).not.toBe(input);
    expect(Object.hasOwn(data["k"] as object, "__proto__")).toBe(false);
    expect(data).toStrictEqual(dataOf(schema.safeParse({ k: withProto(), j: { id: "b" } })));
  });

  it("tuple item and rest element", () => {
    const schema = z.looseObject({ t: z.tuple([member()]).rest(member()) });
    const compiled = compileLikeProduction(schema, "replaceTupleSlots");
    const input = { t: [withProto(), withProto()] };
    const [item, rest] = input.t;
    const data = dataOf<{ t: object[] }>(compiled(input));
    expect(input.t[0]).toBe(item);
    expect(input.t[1]).toBe(rest);
    expect(data.t).not.toBe(input.t);
    expect(data.t.map((slot) => Object.hasOwn(slot, "__proto__"))).toStrictEqual([false, false]);
    expect(data).toStrictEqual(dataOf(schema.safeParse({ t: [withProto(), withProto()] })));
  });

  it("a recursive member rebuilt by its own validator", () => {
    const compiled = compileLikeProduction(Node, "replaceRecursive");
    const input = { id: "a", kids: [{ id: "b", kids: [], extra: 1 }] };
    const [child] = input.kids;
    const data = dataOf<{ kids: object[] }>(compiled(input));
    expect(input.kids[0]).toBe(child);
    expect(input.kids[0]).toHaveProperty("extra", 1);
    expect(data).toStrictEqual(
      dataOf(Node.safeParse({ id: "a", kids: [{ id: "b", kids: [], extra: 1 }] })),
    );
  });

  it("with nothing replaced, every container still comes back by reference", () => {
    // No rest element: one can pad a short input, which makes the tuple — and
    // so the object holding it — a rewriting node that rebuilds regardless.
    const schema = z.looseObject({
      items: z.array(member()),
      r: z.record(z.string(), member()),
      t: z.tuple([member(), member()]),
    });
    const compiled = compileLikeProduction(schema, "replaceNothing");
    const input = { items: [{ id: "a" }], r: { k: { id: "b" } }, t: [{ id: "c" }, { id: "d" }] };
    const data = dataOf<typeof input>(compiled(input));
    expect(data).toBe(input);
    expect(data.items).toBe(input.items);
    expect(data.r).toBe(input.r);
    expect(data.t).toBe(input.t);
  });
});

describe("a preprocessed rewriting container", () => {
  // An identity preprocess hands the inner schema the caller's own container.
  // A rewriting container copies it before its first write, and the copy is
  // what comes back: zod's output, with the caller's container left as it was.
  const cases: [name: string, schema: z.ZodType, make: () => unknown][] = [
    [
      "preprocessArray",
      z.preprocess((v) => v, z.array(z.string().trim().catch("c"))),
      () => [" a ", 1],
    ],
    [
      "preprocessRecord",
      z.preprocess((v) => v, z.record(z.string(), z.string().trim().catch("c"))),
      () => ({ a: " a ", b: 1 }),
    ],
    [
      "preprocessTuple",
      z.preprocess((v) => v, z.tuple([z.string().trim().catch("c"), z.string().trim()])),
      () => [1, " b "],
    ],
  ];

  for (const [name, schema, make] of cases) {
    it(name, () => {
      const input = make();
      expectParity(schema, [input, deepFreeze(make())], name);
      expect(input).toStrictEqual(make());
    });
  }
});

describe("a rewriting member still checks the value it rewrote", () => {
  // A member that rewrites nothing is handed two locals, but a rewriting one
  // keeps a single slot (see visitMember): `.trim().min(1)` has to measure the
  // trimmed string and a coercion has to check the converted value, both read
  // back through the expression they wrote. Split, those checks saw the
  // original — `["  "]` failed with an EMPTY issue list and `["7"]` against
  // `z.coerce.number().min(5)` failed outright.
  const members: [name: string, make: () => z.ZodType, values: unknown[]][] = [
    ["TrimMin", () => z.string().trim().min(1), ["  ", " a "]],
    [
      "TrimLowerRegex",
      () =>
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z]+$/),
      [" AB ", " A1 "],
    ],
    ["CoerceMin", () => z.coerce.number().min(5), ["3", "7", "x"]],
  ];
  const containers: [
    name: string,
    wrap: (member: z.ZodType) => z.ZodType,
    box: (value: unknown) => unknown,
  ][] = [
    ["Array", (m) => z.array(m), (v) => [v]],
    ["Record", (m) => z.record(z.string(), m), (v) => ({ k: v })],
    ["Tuple", (m) => z.tuple([m]), (v) => [v]],
    ["Rest", (m) => z.tuple([]).rest(m), (v) => [v]],
    ["NestedArray", (m) => z.looseObject({ a: z.array(m) }), (v) => ({ a: [v] })],
  ];

  for (const [memberName, make, values] of members) {
    for (const [containerName, wrap, box] of containers) {
      it(`${containerName} of ${memberName}`, () => {
        expectParity(
          wrap(make()),
          values.map((value) => deepFreeze(box(value))),
          `rewrite${containerName}${memberName}`,
        );
      });
    }
  }
});
