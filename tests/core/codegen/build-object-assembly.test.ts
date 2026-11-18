import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { compileLikeProduction } from "../../parity-harness.js";

/**
 * How the build path ASSEMBLES a rebuilt object.
 *
 * zod writes a key when its parsed value is defined or the key was on the input
 * at all, so a key that may come out absent cannot sit in an object literal —
 * and every key after it depends on whether it is there. The build pass used to
 * take the longest leading run of always-present keys as one literal and append
 * the rest store by store, which made an optional key EARLY in the shape turn
 * the whole object into appends (14.8 ns against 9.2 for a twelve-key object).
 * It now selects between literals instead: one per presence pattern of the
 * first conditional keys, each a single allocation with its keys in shape
 * order (see assembleObject).
 */
function assembly(schema: unknown): string {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const result = generateValidator(ir, "o", { refCount: refEntries.length });
  const build = result.code.split("\n").find((line) => line.startsWith("function __vb_"));
  expect(build, "schema should take the build path").toBeDefined();
  const source = build as string;
  // From the output object's first assignment to the end of the function.
  const out = /(__bo_\d+)=/.exec(source)?.[1] as string;
  return source.slice(source.indexOf(`${out}=`));
}

const required = z.string();
const optional = z.string().optional();

/** `{ k0, k1, … }` with the keys at `optionalAt` optional and the rest required. */
function shape(width: number, optionalAt: readonly number[]): z.ZodObject {
  const entries: [string, z.ZodType][] = [];
  for (let index = 0; index < width; index++) {
    entries.push([`k${index}`, optionalAt.includes(index) ? optional : required]);
  }
  return z.object(Object.fromEntries(entries));
}

const count = (source: string, needle: RegExp): number => [...source.matchAll(needle)].length;
const LITERAL = /\{(?:"k\d+":__bv_\d+,?)*\}/g;
const STORE = /__bo_\d+\["k\d+"\]=/g;
const GUARDED_STORE = /if\([^;]*\)\{__bo_\d+\["k\d+"\]=/g;

describe("build path — object assembly", () => {
  it("keeps a single literal when every key is always present", () => {
    const source = assembly(shape(6, []));
    expect(count(source, LITERAL)).toBe(1);
    expect(count(source, STORE)).toBe(0);
    expect(source).not.toContain("?");
  });

  it("leaves a trailing optional key as one guarded store: nothing follows it", () => {
    const source = assembly(shape(6, [5]));
    expect(count(source, LITERAL)).toBe(1);
    expect(count(source, STORE)).toBe(1);
    expect(count(source, GUARDED_STORE)).toBe(1);
    expect(source).not.toContain("?{");
  });

  it("selects between two literals for an optional key with required keys behind it", () => {
    const source = assembly(shape(6, [1]));
    expect(count(source, LITERAL)).toBe(2);
    expect(count(source, STORE)).toBe(0);
    expect(source).toMatch(
      /^__bo_\d+=\(__bv_\d+!==undefined\|\|\("k1" in input\)\)\?\{"k0":__bv_\d+,"k1":__bv_\d+,"k2":/,
    );
    expect(source).toMatch(/:\{"k0":__bv_\d+,"k2":__bv_\d+,/);
  });

  it("selects between four literals for two such keys", () => {
    const source = assembly(shape(6, [1, 3]));
    expect(count(source, LITERAL)).toBe(4);
    expect(count(source, STORE)).toBe(0);
  });

  it("resolves the first two and appends from the third on", () => {
    // k1 and k3 are selected; k5 is the third conditional key, so it and k6/k7
    // behind it are stores, as everything past the first optional key used to be.
    const source = assembly(shape(8, [1, 3, 5]));
    expect(count(source, LITERAL)).toBe(4);
    expect(count(source, GUARDED_STORE)).toBe(1);
    expect(count(source, STORE)).toBe(3);
  });

  it("does not spend a literal on a conditional key that only conditional keys follow", () => {
    // k4 is the last required key: k5 and k6 behind it are guarded stores either way.
    const source = assembly(shape(7, [1, 5, 6]));
    expect(count(source, LITERAL)).toBe(2);
    expect(count(source, GUARDED_STORE)).toBe(2);
    expect(count(source, STORE)).toBe(2);
  });

  it("resolves only one key when four copies of a wide shape would cost more than they save", () => {
    const narrow = assembly(shape(16, [1, 3]));
    expect(count(narrow, LITERAL)).toBe(4);
    const wide = assembly(shape(20, [1, 3]));
    expect(count(wide, LITERAL)).toBe(2);
    // k3 and the sixteen keys behind it.
    expect(count(wide, STORE)).toBe(17);
  });

  it("an object of only optional keys is still an empty literal plus guarded stores", () => {
    const source = assembly(shape(3, [0, 1, 2]));
    expect(source).toMatch(/^__bo_\d+=\{\};/);
    expect(count(source, GUARDED_STORE)).toBe(3);
  });

  it("counts a default as always present: it never needs a literal of its own", () => {
    const source = assembly(
      z.object({ a: required, b: z.string().default("d"), c: optional, d: required }),
    );
    expect(count(source, /\{"a":[^{}]*\}/g)).toBe(2);
    expect(source).toMatch(/\?\{"a":__bv_\d+,"b":__b\w+_\d+,"c":__b\w+_\d+,"d":__bv_\d+\}/);
  });
});

/**
 * The selection has to land every presence pattern on the object zod builds:
 * same keys, same ORDER (which `toEqual` does not look at), same values — with
 * a key counting as present when it is on the input at all, own or inherited,
 * defined or not.
 */
describe("build path — every presence pattern assembles zod's object", () => {
  type Presence = "absent" | "own" | "own-undefined" | "inherited";
  const PRESENCES: readonly Presence[] = ["absent", "own", "own-undefined", "inherited"];

  /** Every assignment of a presence to each optional key. */
  function patterns(optionalAt: readonly number[]): Presence[][] {
    let all: Presence[][] = [[]];
    for (let position = 0; position < optionalAt.length; position++) {
      all = all.flatMap((prefix) => PRESENCES.map((presence) => [...prefix, presence]));
    }
    return all;
  }

  function input(width: number, optionalAt: readonly number[], pattern: readonly Presence[]) {
    const inheritedKeys: Record<string, string> = {};
    const own: Record<string, string | undefined> = {};
    for (let index = 0; index < width; index++) {
      const key = `k${index}`;
      const position = optionalAt.indexOf(index);
      const presence = position === -1 ? "own" : (pattern[position] as Presence);
      if (presence === "own") own[key] = `v${index}`;
      else if (presence === "own-undefined") own[key] = undefined;
      else if (presence === "inherited") inheritedKeys[key] = `p${index}`;
    }
    // An unknown key as well, so the object is stripped rather than merely copied.
    own["unknown"] = "x";
    return Object.assign(Object.create(inheritedKeys) as object, own);
  }

  const SHAPES: [number, number[]][] = [
    [6, [1]],
    [6, [0]],
    [6, [5]],
    [6, [1, 3]],
    [6, [0, 1]],
    [6, [4, 5]],
    [8, [1, 3, 5]],
    [7, [1, 5, 6]],
    [5, [0, 2, 4]],
    [3, [0, 1, 2]],
    [20, [1, 3]],
  ];

  for (const [width, optionalAt] of SHAPES) {
    it(`${width} keys, optional at ${optionalAt.join(", ")}`, () => {
      const schema = shape(width, optionalAt);
      const compiled = compileLikeProduction(schema, "assembled");
      for (const pattern of patterns(optionalAt)) {
        const label = pattern.join("/");
        const expected = schema.safeParse(input(width, optionalAt, pattern));
        const actual = compiled(input(width, optionalAt, pattern));
        expect(actual.success, label).toBe(true);
        expect(expected.success, label).toBe(true);
        if (!actual.success || !expected.success) continue;
        const data = actual.data as Record<string, unknown>;
        expect(Object.keys(data), `${label} (key order)`).toStrictEqual(Object.keys(expected.data));
        expect(data, label).toStrictEqual(expected.data);
        // An own `undefined` survives as a key; an absent one does not come back as one.
        for (const key of Object.keys(expected.data)) {
          expect(Object.hasOwn(data, key), `${label} (${key} own)`).toBe(true);
        }
      }
    });
  }

  it("a default between optional keys lands where zod puts it, whatever is absent", () => {
    const schema = z.object({
      a: optional,
      b: z.string().default("d"),
      c: optional,
      d: required,
      e: z.number().optional(),
    });
    const compiled = compileLikeProduction(schema, "assembledDefault");
    const inputs = [
      { d: "x" },
      { a: "a", d: "x" },
      { c: "c", d: "x" },
      { a: "a", b: "b", c: "c", d: "x", e: 1 },
      { a: undefined, c: undefined, d: "x", e: undefined },
      { b: undefined, d: "x" },
    ];
    for (const value of inputs) {
      const expected = schema.parse(value);
      const actual = compiled(value);
      expect(actual.success).toBe(true);
      if (!actual.success) continue;
      expect(Object.keys(actual.data as object)).toStrictEqual(Object.keys(expected));
      expect(actual.data).toStrictEqual(expected);
    }
  });
});
