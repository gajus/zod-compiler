/**
 * A user callback is handed zod's copy of the value, never the caller's.
 *
 * Zod parses every object, array, tuple, record, set and map into a value of
 * its own making, so a `.transform()`, `.refine()` or `.superRefine()` runs on
 * that copy, and so does any callback a `.pipe()` feeds. The compiled walks
 * return a container that nothing rewrites by reference, and they used to hand
 * that container to the callback too. `.transform(a => a.sort())` sorted the
 * caller's array, and a refine that pushed onto a nested array grew the
 * caller's. Each container a callback receives is now marked during extraction
 * and rebuilt as zod builds it (see extract/fresh.ts).
 *
 * Every check here runs a callback that edits its argument everywhere it can
 * (see `scribble`), through each way a compiled schema is called. It then asks
 * three questions: is the caller's input as it was, is the result zod's, and
 * does the output share any container with the input that zod's does not?
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import type { CodegenMode } from "#src/core/types.js";
import { installOnto } from "./parity-harness.js";
import { buildSeed, FOREIGN } from "./structural-gen.js";

/**
 * Edit every container reachable from `value`: append to arrays, add a key to
 * objects, add to sets and maps. Frozen containers are left alone, since zod
 * freezes what `.readonly()` returns and an edit would throw. Deterministic, so
 * zod's copy and the compiled one come out edited alike.
 */
function scribble(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Date) return;
  const frozen = Object.isFrozen(value);
  if (Array.isArray(value)) {
    for (const element of value) scribble(element, seen);
    if (!frozen) value.push("scribbled");
  } else if (value instanceof Set) {
    for (const element of value) scribble(element, seen);
    if (!frozen) value.add("scribbled");
  } else if (value instanceof Map) {
    for (const [key, entry] of value) {
      scribble(key, seen);
      scribble(entry, seen);
    }
    if (!frozen) value.set("scribbled", 1);
  } else {
    for (const key of Object.keys(value)) scribble((value as Record<string, unknown>)[key], seen);
    if (!frozen) (value as Record<string, unknown>)["scribbled"] = true;
  }
}

/** A value's whole shape as text, so a snapshot taken before a parse shows any write. */
function shapeOf(value: unknown, seen = new Map<object, number>()): string {
  if (typeof value === "symbol") return `symbol(${value.description})`;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object" || value === null) return `${typeof value}:${String(value)}`;
  const known = seen.get(value);
  if (known !== undefined) return `<ref ${known}>`;
  seen.set(value, seen.size);
  if (value instanceof Date) return `Date(${value.getTime()})`;
  if (value instanceof Map) {
    return `Map(${[...value].map(([key, entry]) => `${shapeOf(key, seen)}=>${shapeOf(entry, seen)}`).join(",")})`;
  }
  if (value instanceof Set)
    return `Set(${[...value].map((entry) => shapeOf(entry, seen)).join(",")})`;
  const frozen = Object.isFrozen(value) ? "frozen " : "";
  const entries = Reflect.ownKeys(value).map(
    (key) => `${String(key)}:${shapeOf((value as Record<PropertyKey, unknown>)[key], seen)}`,
  );
  return `${frozen}${Array.isArray(value) ? "Array" : "Object"}{${entries.join(",")}}`;
}

/** Every object reachable from `value`. */
function objectsIn(value: unknown, into = new Set<object>()): Set<object> {
  if (typeof value !== "object" || value === null || into.has(value)) return into;
  into.add(value);
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      objectsIn(key, into);
      objectsIn(entry, into);
    }
  } else if (value instanceof Set) {
    for (const entry of value) objectsIn(entry, into);
  } else {
    for (const key of Reflect.ownKeys(value)) {
      objectsIn((value as Record<PropertyKey, unknown>)[key], into);
    }
  }
  return into;
}

/** How many objects of `output` ARE objects of `input`. */
function aliases(input: unknown, output: unknown): number {
  const inputs = objectsIn(input);
  return [...objectsIn(output)].filter((object) => inputs.has(object)).length;
}

type Surface = z.ZodType & { is?: (input: unknown) => boolean };

/** Every way the schema is called, each one reduced to what a caller can see. */
const ENTRY_POINTS: [string, (schema: Surface, input: unknown) => unknown][] = [
  ["safeParse", (schema, input) => schema.safeParse(input)],
  ["parse", (schema, input) => schema.parse(input)],
  ["safeParseAsync", (schema, input) => schema.safeParseAsync(input)],
  ["~standard.validate", (schema, input) => schema["~standard"].validate(input)],
  ["z.safeParse(schema, x)", (schema, input) => z.safeParse(schema, input)],
  ["an uncompiled parent", (schema, input) => z.object({ v: schema }).safeParse({ v: input })],
];

/** A result as text, an error by its issues. */
async function settle(run: () => unknown): Promise<unknown> {
  try {
    const result = await run();
    if (typeof result === "object" && result !== null && "error" in result) {
      const { success, data, error } = result as {
        success: boolean;
        data?: unknown;
        error?: z.ZodError;
      };
      return { success, data: shapeOf(data), issues: error?.issues };
    }
    if (typeof result === "object" && result !== null && "issues" in result) {
      return { issues: (result as { issues: unknown }).issues };
    }
    return { value: shapeOf(result) };
  } catch (error) {
    return { threw: error instanceof z.ZodError ? error.issues : String(error) };
  }
}

/**
 * The same check on zod and on the compiled twin. The caller's input ends up
 * exactly as zod leaves it, the result is zod's, and the output aliases no more
 * of the input than zod's does. Zod does hand a callback some of the caller's
 * data by reference (the unknown keys of a loose object, a `z.any()` member)
 * and so edits it too, which is why the input is compared with zod's rather
 * than with how it started. Each parse gets an input of its own, so one
 * parse's edits cannot leak into the other's.
 *
 * `aliasing: false` skips the last check, for a schema with containers outside
 * any callback's argument, which come back by reference: the documented
 * container-identity difference.
 */
async function expectZodsCopy(
  make: () => z.ZodType,
  input: () => unknown,
  mode: CodegenMode,
  options?: { aliasing?: boolean },
): Promise<void> {
  for (const [label, call] of ENTRY_POINTS) {
    const plain = make();
    const compiled = installOnto(make(), { mode });
    const zodInput = input();
    const compiledInput = input();
    const zodResult = await settle(() => call(plain, zodInput));
    const compiledResult = await settle(() => call(compiled, compiledInput));
    expect(shapeOf(compiledInput), `${label}: the caller's input`).toBe(shapeOf(zodInput));
    expect(compiledResult, label).toStrictEqual(zodResult);
  }
  if (options?.aliasing === false) return;
  const plain = make();
  const compiled = installOnto(make(), { mode });
  const zodInput = input();
  const compiledInput = input();
  const zodOut = plain.safeParse(zodInput);
  const ourOut = compiled.safeParse(compiledInput);
  if (zodOut.success && ourOut.success) {
    expect(aliases(compiledInput, ourOut.data), "aliased").toBe(aliases(zodInput, zodOut.data));
  }
}

/** Callbacks that edit their argument, each attached the way users write it. */
const CALLBACKS: [string, (schema: z.ZodType) => z.ZodType][] = [
  [
    "a transform that edits and returns its argument",
    (schema) =>
      schema.transform((value) => {
        scribble(value);
        return value;
      }),
  ],
  [
    "a refine that edits its argument",
    (schema) =>
      schema.refine((value) => {
        scribble(value);
        return true;
      }),
  ],
  [
    "a superRefine that edits its argument",
    (schema) =>
      schema.superRefine((value) => {
        scribble(value);
      }),
  ],
  [
    "a failing refine that edits its argument",
    (schema) =>
      schema.refine((value) => {
        scribble(value);
        return false;
      }, "never"),
  ],
  [
    "a pipe into a custom check that edits its argument",
    (schema) =>
      schema.pipe(
        z.custom((value) => {
          scribble(value);
          return true;
        }),
      ),
  ],
];

const sparse = (): unknown[] => {
  const array: unknown[] = [1];
  array[2] = 3;
  return array;
};

/** Containers, with an input each accepts. */
const SHAPES: [string, () => z.ZodType, () => unknown][] = [
  ["an array of numbers", () => z.array(z.number()), () => [3, 1, 2]],
  ["a sparse array", () => z.array(z.number().optional()), sparse],
  ["an array of arrays", () => z.array(z.array(z.number())), () => [[1], [2, 3]]],
  [
    "a stripping object holding an array",
    () => z.object({ tags: z.array(z.string()), n: z.number() }),
    () => ({ n: 1, tags: ["a"], extra: { kept: false } }),
  ],
  [
    "a strict object holding an array",
    () => z.strictObject({ id: z.number(), tags: z.array(z.string()) }),
    () => ({ tags: ["a"], id: 1 }),
  ],
  ["a loose object", () => z.looseObject({ a: z.number() }), () => ({ b: [1], a: 1 })],
  [
    "a catchall",
    () => z.object({ a: z.number() }).catchall(z.array(z.number())),
    () => ({ x: [1], a: 1 }),
  ],
  ["a record", () => z.record(z.string(), z.array(z.number())), () => ({ b: [1], a: [2] })],
  ["a set", () => z.set(z.number()), () => new Set([1, 2])],
  ["a map", () => z.map(z.string(), z.array(z.number())), () => new Map([["k", [1]]])],
  ["a tuple", () => z.tuple([z.array(z.number()), z.number()]), () => [[1], 2]],
  [
    "a union of containers",
    () => z.union([z.array(z.string()), z.object({ a: z.array(z.number()) })]),
    () => ({ a: [1] }),
  ],
  [
    "a discriminated union",
    () =>
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("a"), tags: z.array(z.string()) }),
        z.object({ kind: z.literal("b") }),
      ]),
    () => ({ kind: "a", tags: ["x"] }),
  ],
  ["an optional array", () => z.array(z.number()).optional(), () => [1]],
  ["a defaulted array", () => z.object({ list: z.array(z.number()).default([]) }), () => ({})],
  ["a frozen array", () => z.array(z.array(z.number())).readonly(), () => [[1]]],
  [
    "an array under an intersection",
    () =>
      z.intersection(
        z.looseObject({ list: z.array(z.number()) }),
        z.looseObject({ n: z.number() }),
      ),
    () => ({ list: [1], n: 1 }),
  ],
  [
    "a member deeper down",
    () => z.object({ outer: z.object({ list: z.array(z.number()) }).strict() }),
    () => ({ outer: { list: [1] } }),
  ],
];

const MODES: CodegenMode[] = ["inline", "lean"];

describe("a callback is handed zod's copy", () => {
  for (const [shapeLabel, shape, input] of SHAPES) {
    for (const [callbackLabel, attach] of CALLBACKS) {
      for (const mode of MODES) {
        it(`${shapeLabel}, ${callbackLabel} (${mode})`, async () => {
          await expectZodsCopy(() => attach(shape()), input, mode);
        });
      }
    }
  }

  it("a callback on a member, under an object that rebuilds", async () => {
    await expectZodsCopy(
      () =>
        z.object({
          list: z.array(z.number()).transform((value) => {
            scribble(value);
            return value;
          }),
          other: z.array(z.number()),
        }),
      () => ({ list: [1], other: [2] }),
      "inline",
      { aliasing: false },
    );
  });

  it("a recursive schema whose callback reaches back up the cycle", async () => {
    const make = () => {
      const Node: z.ZodType = z.strictObject({
        value: z.number(),
        get children() {
          return z.array(Node).refine((kids) => {
            scribble(kids);
            return true;
          });
        },
      });
      return Node;
    };
    await expectZodsCopy(
      make,
      () => ({ value: 1, children: [{ value: 2, children: [] }] }),
      "inline",
    );
  });

  it("a recursive schema whose callback reaches a container off the cycle", async () => {
    // The refine sits on `children`, so the cycle is rebuilt anyway; `tags` is
    // reached only through the recursion target, whose containers are marked
    // once it is finished extracting.
    const make = () => {
      const Node: z.ZodType = z.strictObject({
        value: z.number(),
        tags: z.array(z.string()),
        get children() {
          return z.array(Node).refine((kids) => {
            scribble(kids);
            return true;
          });
        },
      });
      return Node;
    };
    const tree = () => ({
      value: 1,
      tags: ["t"],
      children: [{ value: 2, tags: ["u"], children: [] }],
    });
    // As the root, and as a target nested in a larger schema, which dispatch
    // marks rather than extractSchema.
    await expectZodsCopy(make, tree, "inline");
    await expectZodsCopy(
      () => z.object({ tree: make() }),
      () => ({ tree: tree() }),
      "inline",
    );
  });
});

describe("`.is()` decides on the value zod's callback sees", () => {
  const cases: [string, () => z.ZodType, unknown][] = [
    [
      "a refine on a stripping object, which never sees unknown keys",
      () => z.object({ a: z.string() }).refine((value) => !("b" in value)),
      { a: "x", b: 1 },
    ],
    [
      "a refine that reads a substituted default",
      () => z.object({ a: z.number().default(5) }).refine((value) => value.a === 5),
      {},
    ],
    [
      "a refine that counts a sparse array's own elements",
      () => z.array(z.number().optional()).refine((value) => Object.keys(value).length === 3),
      sparse(),
    ],
  ];
  for (const [label, make, input] of cases) {
    it(label, () => {
      const compiled = installOnto(make()) as Surface;
      expect(compiled.is?.(input)).toBe(make().safeParse(input).success);
    });
  }
});

describe("a callback is handed zod's copy — generated schemas", () => {
  for (let seed = 1; seed <= 120; seed++) {
    it(`seed ${seed}`, () => {
      const attach = (schema: z.ZodType) =>
        schema.transform((value) => {
          scribble(value);
          return value;
        });
      const plain = attach(buildSeed(seed).schema);
      const compiled = installOnto(attach(buildSeed(seed).schema));
      const gen = buildSeed(seed);
      for (const make of [gen.good, gen.bad, ...FOREIGN.map((value) => () => value)]) {
        // One input for both: a generated value can hold what no second copy
        // would equal (a fresh symbol). Zod never edits its input, so it parses
        // first, and the snapshot it leaves behind is what the compiled parse
        // must leave behind too.
        const input = make();
        const zodResult = plain.safeParse(input);
        const before = shapeOf(input);
        const ours = compiled.safeParse(input);
        expect(shapeOf(input), "the caller's input").toBe(before);
        expect(ours.success).toBe(zodResult.success);
        if (ours.success && zodResult.success) {
          expect(shapeOf(ours.data)).toBe(shapeOf(zodResult.data));
        }
      }
    });
  }
});
