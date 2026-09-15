/**
 * A value a member hands back in place of its input reaches the output.
 *
 * A schema that rewrites nothing can still hand back a REPLACEMENT: a loose
 * object or a record drops an own `__proto__` key onto a copy, and a recursive
 * member is rebuilt — stripped — by its own validator. zod's output carries the
 * replacement. A Set, a Map and a discriminated union handed back their input
 * whenever no member schema mutated, so the replacement was dropped: an own
 * `__proto__` rode along into the output, where `Object.assign` turns it into a
 * prototype swap, and a recursive member kept keys zod strips.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import type { SafeParseSuccess } from "#src/core/types.js";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

const dataOf = <T>(result: { success: boolean }): T => (result as SafeParseSuccess<T>).data;

/** An object with an own `__proto__` key, as `JSON.parse` creates one. */
const withProto = (id: string): Record<string, unknown> =>
  JSON.parse(`{"id":"${id}","__proto__":{"polluted":true}}`) as Record<string, unknown>;

const hasOwnProto = (value: unknown): boolean => Object.hasOwn(value as object, "__proto__");

const idsOf = (values: Iterable<unknown>): unknown[] =>
  [...values].map((value) => (value as { id: unknown }).id);

/** Hands back a copy without the key whenever its input carries an own `__proto__`. */
const member = () => z.looseObject({ id: z.string() });

/*
 * Recursive through a Set and a Map, with a `.catch()` that keeps each off the
 * build path so the eager walk produces the output. A child is rebuilt —
 * stripped of `extra` — by the recursive validator, not by the container
 * holding it.
 */
const SetNode: z.ZodType = z.object({
  id: z.string().catch("?"),
  kids: z.set(z.lazy(() => SetNode)),
});
const MapNode: z.ZodType = z.object({
  id: z.string().catch("?"),
  kids: z.map(
    z.string(),
    z.lazy(() => MapNode),
  ),
});

describe("set", () => {
  it("an element's replacement takes its place, in order", () => {
    const schema = z.set(member());
    const compiled = compileLikeProduction(schema, "setReplacement");
    const make = () => new Set<object>([{ id: "a" }, withProto("b"), { id: "c" }]);
    const input = make();
    const [, polluted] = input;
    const data = dataOf<Set<object>>(compiled(input));
    expect(data).not.toBe(input);
    expect(idsOf(data)).toStrictEqual(["a", "b", "c"]);
    expect([...data].map(hasOwnProto)).toStrictEqual([false, false, false]);
    expect(data).toStrictEqual(dataOf(schema.safeParse(make())));
    expect([...input][1]).toBe(polluted);
    expect(hasOwnProto(polluted)).toBe(true);
  });

  it("a recursive element rebuilt by its own validator", () => {
    const compiled = compileLikeProduction(SetNode, "setRecursive");
    const make = () => ({ id: "a", kids: new Set([{ id: "b", kids: new Set(), extra: 1 }]) });
    const input = make();
    const [child] = input.kids;
    expect(dataOf(compiled(input))).toStrictEqual(dataOf(SetNode.safeParse(make())));
    expect([...input.kids][0]).toBe(child);
    expect(child).toHaveProperty("extra", 1);
  });

  it("with nothing replaced, the Set still comes back by reference", () => {
    const compiled = compileLikeProduction(z.set(member()), "setUnreplaced");
    const input = new Set([{ id: "a" }, { id: "b" }]);
    expect(dataOf(compiled(input))).toBe(input);
  });

  it("keeps zod's verdicts, outputs and issues", () => {
    expectParity(
      z.set(member()).min(2),
      [
        new Set([{ id: "a" }, withProto("b")]),
        new Set([withProto("a"), { id: 1 }]),
        new Set([withProto("a")]),
      ],
      "setParity",
    );
  });
});

describe("map", () => {
  it("a value's replacement takes its place, in order", () => {
    const schema = z.map(z.string(), member());
    const compiled = compileLikeProduction(schema, "mapValueReplacement");
    const make = () =>
      new Map<string, object>([
        ["a", { id: "a" }],
        ["b", withProto("b")],
        ["c", { id: "c" }],
      ]);
    const input = make();
    const polluted = input.get("b");
    const data = dataOf<Map<string, object>>(compiled(input));
    expect(data).not.toBe(input);
    expect([...data.keys()]).toStrictEqual(["a", "b", "c"]);
    expect([...data.values()].map(hasOwnProto)).toStrictEqual([false, false, false]);
    expect(data).toStrictEqual(dataOf(schema.safeParse(make())));
    expect(input.get("b")).toBe(polluted);
    expect(hasOwnProto(polluted)).toBe(true);
  });

  it("a key's replacement takes its place", () => {
    const compiled = compileLikeProduction(z.map(member(), z.number()), "mapKeyReplacement");
    const polluted = withProto("b");
    const input = new Map<object, number>([
      [{ id: "a" }, 1],
      [polluted, 2],
    ]);
    const data = dataOf<Map<object, number>>(compiled(input));
    expect(idsOf(data.keys())).toStrictEqual(["a", "b"]);
    expect([...data.keys()].map(hasOwnProto)).toStrictEqual([false, false]);
    expect([...data.values()]).toStrictEqual([1, 2]);
    expect(input.has(polluted)).toBe(true);
    expect(hasOwnProto(polluted)).toBe(true);
  });

  it("a recursive value rebuilt by its own validator", () => {
    const compiled = compileLikeProduction(MapNode, "mapRecursive");
    const make = () => ({
      id: "a",
      kids: new Map([["b", { id: "b", kids: new Map(), extra: 1 }]]),
    });
    const input = make();
    const child = input.kids.get("b");
    expect(dataOf(compiled(input))).toStrictEqual(dataOf(MapNode.safeParse(make())));
    expect(input.kids.get("b")).toBe(child);
    expect(child).toHaveProperty("extra", 1);
  });

  it("with nothing replaced, the Map still comes back by reference", () => {
    const compiled = compileLikeProduction(z.map(z.string(), member()), "mapUnreplaced");
    const input = new Map([["a", { id: "a" }]]);
    expect(dataOf(compiled(input))).toBe(input);
  });

  it("keeps zod's verdicts, outputs and issues, rewriting keys included", () => {
    expectParity(
      z.map(z.string(), member()),
      [
        new Map([
          ["a", withProto("a")],
          ["b", { id: 1 }],
        ]),
        new Map([[1, withProto("a")]]),
        "x",
      ],
      "mapParity",
    );
    expectParity(
      z.map(z.string().trim(), member()),
      [
        new Map([
          [" a ", withProto("a")],
          ["b", { id: "b" }],
        ]),
        new Map([[" a ", { id: 1 }]]),
      ],
      "mapRewritingParity",
    );
  });
});

describe("discriminated union", () => {
  const schema = z.looseObject({
    u: z.discriminatedUnion("t", [
      z.looseObject({ t: z.literal("a"), n: member().optional() }),
      z.looseObject({ t: z.literal("b") }),
    ]),
  });
  const pollutedOption = () =>
    JSON.parse('{"t":"a","__proto__":{"polluted":true}}') as Record<string, unknown>;

  it("the matched option's replacement is the output", () => {
    const compiled = compileLikeProduction(schema, "duReplacement");
    const input = { u: pollutedOption() };
    const option = input.u;
    const data = dataOf<{ u: object }>(compiled(input));
    expect(hasOwnProto(data.u)).toBe(false);
    expect(data).toStrictEqual(dataOf(schema.safeParse({ u: pollutedOption() })));
    expect(input.u).toBe(option);
    expect(hasOwnProto(option)).toBe(true);
  });

  it("a replacement nested inside the matched option", () => {
    const compiled = compileLikeProduction(schema, "duNestedReplacement");
    const make = () => ({ u: { t: "a", n: withProto("n") } });
    const input = make();
    const data = dataOf<{ u: { n: object } }>(compiled(input));
    expect(hasOwnProto(data.u.n)).toBe(false);
    expect(data).toStrictEqual(dataOf(schema.safeParse(make())));
    expect(hasOwnProto(input.u.n)).toBe(true);
  });

  it("with nothing replaced, the option still comes back by reference", () => {
    const compiled = compileLikeProduction(schema, "duUnreplaced");
    const input = { u: { t: "b" } };
    const data = dataOf<{ u: object }>(compiled(input));
    expect(data).toBe(input);
    expect(data.u).toBe(input.u);
  });
});
