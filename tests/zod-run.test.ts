/**
 * A compiled schema reached THROUGH zod.
 *
 * `__zcMkv` installs compiled methods on the schema object, and zod's own
 * traversal never calls them: a parent parses a child through
 * `child._zod.run`, and the functional API (`z.safeParse(schema, x)`) goes
 * straight to the root's. So a compiled schema composed into an uncompiled
 * parent — one built in a function, by a generic factory, by `.optional()` at a
 * call site — used to run entirely on zod. `__zcZr` now puts the validator in
 * front of `_zod.run` as well (see ZOD_RUN_DECL).
 *
 * These routes produced ZOD's output before, for callers that never asked for a
 * compiled one, so the bar is higher than for the schema's own methods: nothing
 * observable may change except the time it takes. Hence the restriction to
 * validators whose output zod would have built itself (`zodRunSupport`), and
 * hence most of this file — every route compared against a plain twin on what
 * it returns, what it reports, what it aliases and what it freezes.
 */
import { describe, expect, it } from "vite-plus/test";
import { core, z } from "zod";
import * as zm from "zod/mini";
import { zodRunSupport } from "#src/core/codegen/build-path.js";
import { generateValidator } from "#src/core/codegen/index.js";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import { iifeHelperNames, ZOD_RUN_HELPER } from "#src/core/iife.js";
import { compileSchemas } from "#src/core/pipeline.js";
import { jit } from "#src/jit.js";
import { installLikeProduction, installOnto, type InstallOptions } from "./parity-harness.js";
import { buildSeed, FOREIGN, type Gen, rng } from "./structural-gen.js";

type Run = ((payload: Payload, ctx?: object) => Payload) & { __originalRun?: unknown };
interface Payload {
  value: unknown;
  issues: unknown[];
}
interface Internals {
  run: Run;
  parse: (payload: Payload, ctx: object) => Payload;
}
const internals = (schema: unknown): Internals => (schema as { _zod: Internals })._zod;

/** Has `__zcZr` put a compiled `run` on this schema? */
const servesZod = (schema: unknown): boolean =>
  typeof internals(schema).run.__originalRun === "function";

const FALLBACK = Symbol.for("zod.compile.fallback");

/** What the validator generator decided for a schema: "sync", "async" or null. */
function support(schema: unknown): "sync" | "async" | null {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  return generateValidator(ir, "s", { refCount: refEntries.length }).zodRun ?? null;
}

/**
 * What the PREDICATE says of a schema's shape, whichever walk the generator
 * then picks. The two agree wherever the generator emits a build pass or a
 * by-reference check; asked separately because the generator also withholds
 * the answer from every validator that runs the eager walk, which would hide a
 * predicate that had stopped declining one of those shapes itself.
 */
function shapeSupport(schema: unknown): "sync" | "async" | null {
  return zodRunSupport(extractSchema(schema, []));
}

/**
 * Count every time zod's own runtime is asked to parse this schema, from here
 * on. Works for a schema with no checks of its own — an object, an array — where
 * zod keeps `run` and `parse` as one function and the wrapper reads `parse` at
 * call time. Installed as an accessor because zod REASSIGNS `parse` on such a
 * schema's first runtime parse (its memoizer takes itself back out), which
 * would otherwise take the counter out with it.
 */
function countRuntime(schema: unknown): { readonly calls: number } {
  const zod = internals(schema);
  let current = zod.parse;
  const counter = { calls: 0 };
  const counting: Internals["parse"] = (payload, ctx) => {
    counter.calls++;
    return current(payload, ctx);
  };
  Object.defineProperty(zod, "parse", {
    configurable: true,
    get: () => counting,
    set: (next: Internals["parse"]) => {
      current = next;
    },
  });
  return counter;
}

// ─── 1. Which validators may answer for zod ─────────────────────────────────

describe("zod run — which schemas qualify", () => {
  const Item = () => z.object({ id: z.number().int(), name: z.string().min(1) });

  const ASYNC: [string, () => z.ZodType][] = [
    ["a string with checks", () => z.string().min(3).max(10)],
    ["an email", () => z.email()],
    ["a number", () => z.number().int().positive()],
    ["an enum", () => z.enum(["a", "b"])],
    ["a literal", () => z.literal("x")],
    ["a date", () => z.date()],
    ["a union of primitives", () => z.union([z.string(), z.number()])],
    ["a stripping object", Item],
    [
      "nested stripping objects",
      () => z.object({ item: Item(), meta: z.object({ n: z.number() }) }),
    ],
    [
      "optional and nullable members",
      () => z.object({ a: z.string().optional(), b: Item().nullable() }),
    ],
    ["an array of stripping objects", () => z.array(Item())],
    [
      "an object holding such an array",
      () => z.object({ items: z.array(Item()), total: z.number() }),
    ],
    ["a tuple with a rebuilt member", () => z.tuple([Item(), z.number()])],
    ["an array of coerced numbers", () => z.array(z.coerce.number())],
    ["an array of trimmed strings", () => z.array(z.string().trim())],
    ["defaults", () => z.object({ page: z.number().default(1), q: z.string() })],
    [
      "coercion and overwrites",
      () => z.object({ n: z.coerce.number(), s: z.string().trim().toLowerCase() }),
    ],
    ["a url", () => z.object({ u: z.url() })],
    [
      "a discriminated union of stripping objects",
      () =>
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a"), a: z.string() }),
          z.object({ kind: z.literal("b"), b: z.number() }),
        ]),
    ],
    ["a frozen stripping object", () => Item().readonly()],
    ["a pipe of primitives", () => z.string().pipe(z.string().min(2))],
    [
      "an any member, by reference in zod too",
      () => z.object({ payload: z.any(), u: z.unknown() }),
    ],
    [
      "a dynamic error map (issues from zod, verdict compiled)",
      () => z.object({ a: z.string({ error: (issue) => `bad ${issue.code}` }) }),
    ],
    [
      "a disjoint-key intersection, which extraction collapses into one object",
      () => z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
    ],
  ];

  const SYNC: [string, () => z.ZodType][] = [
    ["a refinement", () => Item().refine((v) => v.id > 0)],
    ["a refined member", () => z.object({ a: z.string().refine((s) => s !== "no") })],
    ["a transform", () => z.string().transform((s) => s.length)],
    ["a transform on an object", () => Item().transform((v) => ({ ...v, extra: true }))],
    ["a preprocess", () => z.preprocess((v) => String(v), z.string())],
    ["z.custom()", () => z.object({ f: z.custom<string>((v) => typeof v === "string") })],
    ["z.instanceof()", () => z.instanceof(Date)],
  ];

  const NEVER: [string, () => z.ZodType][] = [
    ["an array of primitives (by reference)", () => z.array(z.string())],
    ["an object holding one", () => z.object({ tags: z.array(z.string()) })],
    ["a tuple of primitives", () => z.tuple([z.string(), z.number()])],
    ["a strict object", () => z.strictObject({ a: z.string() })],
    [
      "a strict object nested in a stripping one",
      () => z.object({ s: z.strictObject({ a: z.string() }) }),
    ],
    ["a loose object", () => z.looseObject({ a: z.string() })],
    ["a catchall", () => z.object({ a: z.string() }).catchall(z.number())],
    ["a record", () => z.record(z.string(), z.number())],
    ["a record of rebuilt values (symbol keys)", () => z.record(z.string(), Item())],
    ["a set", () => z.set(z.string())],
    ["a map", () => z.map(z.string(), z.number())],
    [
      "an overlapping intersection (delegated)",
      () => z.intersection(z.object({ a: z.string() }), z.object({ a: z.string(), b: z.number() })),
    ],
    ["an intersection of primitives", () => z.intersection(z.string().min(1), z.string().max(5))],
    ["a catch", () => z.object({ n: z.number().catch(0) })],
    ["a superRefine", () => Item().superRefine(() => {})],
    ["a superRefine on a member", () => z.object({ a: z.string().superRefine(() => {}) })],
    ["a frozen copy of a pass-through array", () => z.array(z.number()).readonly()],
    ["a delegated member", () => z.object({ t: z.jwt() })],
    ["a schema delegated whole", () => Item().check(() => {})],
    [
      "a recursive schema",
      () => {
        const Node: z.ZodType = z.object({
          value: z.number(),
          get next() {
            return Node.optional();
          },
        });
        return Node;
      },
    ],
    ["z.any(), which has nothing to shortcut", () => z.any()],
  ];

  for (const [label, make] of ASYNC) {
    it(`sync and async parses: ${label}`, () => {
      expect(shapeSupport(make())).toBe("async");
      expect(support(make())).toBe("async");
      expect(servesZod(installOnto(make()))).toBe(true);
    });
  }
  for (const [label, make] of SYNC) {
    it(`synchronous parses only: ${label}`, () => {
      expect(shapeSupport(make())).toBe("sync");
      expect(support(make())).toBe("sync");
      expect(servesZod(installOnto(make()))).toBe(true);
    });
  }
  for (const [label, make] of NEVER) {
    it(`left to zod: ${label}`, () => {
      // `z.any()` is the one shape the predicate has no objection to: there is
      // simply no validator to put in front of zod.
      if (!label.startsWith("z.any()")) expect(shapeSupport(make())).toBeNull();
      expect(support(make())).toBeNull();
      expect(servesZod(installOnto(make()))).toBe(false);
    });
  }

  it("is never installed on a method bag, which zod cannot reach", () => {
    const schema = Item();
    const [bag] = installLikeProduction([schema], { zodCompat: false });
    expect(servesZod(schema)).toBe(false);
    expect(Object.hasOwn(bag as object, "_zod")).toBe(false);
  });

  it("is imported by a lean-mode file only where an IIFE calls it", () => {
    const info = (schema: z.ZodType) => {
      const { schemas } = compileSchemas([{ exportName: "S", schema }], { mode: "lean" });
      const [only] = schemas;
      if (only === undefined) throw new Error("expected a compiled schema");
      return only;
    };
    expect(iifeHelperNames(info(Item()))).toContain(ZOD_RUN_HELPER);
    expect(iifeHelperNames(info(Item()), { zodCompat: false })).not.toContain(ZOD_RUN_HELPER);
    expect(iifeHelperNames(info(z.array(z.string())))).not.toContain(ZOD_RUN_HELPER);
  });
});

// ─── 2. Every route through zod, against a plain twin ───────────────────────

/** Every object reachable from `value`, cycles included. */
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
    for (const key of Reflect.ownKeys(value))
      objectsIn((value as Record<PropertyKey, unknown>)[key], into);
  }
  return into;
}

/**
 * Where an output shares structure with its input: the path of every object in
 * `output` that IS an object of `input`, and of every frozen one. Two parses
 * that agree on this, on the data and on the issues are indistinguishable.
 */
function identityOf(input: unknown, output: unknown): string[] {
  const inputs = objectsIn(input);
  const found: string[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (inputs.has(value)) found.push(`${path} is the input's`);
    if (Object.isFrozen(value)) found.push(`${path} is frozen`);
    if (value instanceof Map) {
      let index = 0;
      for (const [key, entry] of value) {
        walk(key, `${path}<key ${index}>`);
        walk(entry, `${path}<value ${index}>`);
        index++;
      }
    } else if (value instanceof Set) {
      let index = 0;
      for (const entry of value) walk(entry, `${path}<${index++}>`);
    } else {
      for (const key of Reflect.ownKeys(value)) {
        walk((value as Record<PropertyKey, unknown>)[key], `${path}.${String(key)}`);
      }
    }
  };
  walk(output, "$");
  return found.sort();
}

/**
 * A value's whole shape as text — constructors, own keys in order, every
 * primitive — so that one taken before a parse and one after show any write.
 */
function shapeOf(value: unknown, seen = new Map<object, number>()): string {
  if (typeof value === "symbol") return `symbol(${value.description})`;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object" || value === null) return `${typeof value}:${String(value)}`;
  const known = seen.get(value);
  if (known !== undefined) return `<ref ${known}>`;
  seen.set(value, seen.size);
  const name = Object.getPrototypeOf(value)?.constructor?.name ?? "null";
  if (value instanceof Date) return `Date(${value.getTime()})`;
  if (value instanceof Map) {
    return `Map(${[...value].map(([key, entry]) => `${shapeOf(key, seen)}=>${shapeOf(entry, seen)}`).join(",")})`;
  }
  if (value instanceof Set)
    return `Set(${[...value].map((entry) => shapeOf(entry, seen)).join(",")})`;
  const entries = Reflect.ownKeys(value).map(
    (key) => `${String(key)}:${shapeOf((value as Record<PropertyKey, unknown>)[key], seen)}`,
  );
  return `${name}{${entries.join(",")}}`;
}

/** One parse, reduced to everything a caller could tell two parses apart by. */
function observe(parent: z.ZodType, makeInput: () => unknown, params?: object): unknown {
  const input = makeInput();
  const before = shapeOf(input);
  let result: ReturnType<typeof z.safeParse>;
  try {
    result = z.safeParse(parent, input, params as never);
  } catch (error) {
    // Zod raises rather than reports in a few places (an unmergeable
    // intersection); the twin has to raise the same thing.
    return { threw: String(error), inputUntouched: untouched(input, before) };
  }
  return {
    success: result.success,
    data: result.success ? result.data : undefined,
    issues: result.success ? undefined : result.error.issues,
    identity: result.success ? identityOf(input, result.data) : undefined,
    inputUntouched: untouched(input, before),
  };
}

/** Has nothing been done to the caller's own value — not a write, not a freeze? */
function untouched(input: unknown, before: string): boolean {
  return (
    shapeOf(input) === before && [...objectsIn(input)].every((object) => !Object.isFrozen(object))
  );
}

/** A child schema, values it accepts and values it rejects (each built fresh per use). */
type ChildCase = [
  label: string,
  make: () => z.ZodType,
  accepted: (() => unknown)[],
  rejected: (() => unknown)[],
];

const User = () =>
  z.object({
    name: z.string().min(2),
    email: z.email(),
    age: z.number().int().positive().optional(),
    role: z.enum(["user", "admin"]).default("user"),
  });

const CHILDREN: ChildCase[] = [
  [
    "an object of primitives",
    User,
    [
      () => ({ name: "Ada", email: "ada@example.com", extra: 1 }),
      () => ({ name: "Bo", email: "bo@example.com", age: 3, role: "admin" }),
    ],
    [
      () => ({ name: "A", email: "nope" }),
      () => ({ name: "Ada", email: "ada@example.com", age: -1 }),
      () => "x",
      () => null,
    ],
  ],
  [
    "a string format",
    () => z.string().min(3).max(8),
    [() => "abcd"],
    [() => "ab", () => "abcdefghi", () => 7],
  ],
  [
    "nested objects and an array of them",
    () =>
      z.object({
        id: z.coerce.number(),
        owner: User(),
        items: z.array(z.object({ sku: z.string().trim(), qty: z.number().int() })),
        at: z.date(),
        opaque: z.any(),
      }),
    [
      () => ({
        id: "7",
        owner: { name: "Ada", email: "ada@example.com" },
        items: [
          { sku: " a ", qty: 1, drop: true },
          { sku: "b", qty: 2 },
        ],
        at: new Date(0),
        opaque: { kept: ["by", "reference"] },
      }),
    ],
    [
      () => ({
        id: "x",
        owner: { name: "Ada", email: "ada@example.com" },
        items: [],
        at: new Date(0),
      }),
      () => ({
        id: 1,
        owner: { name: "A", email: "no" },
        items: [{ sku: 1, qty: 1.5 }],
        at: "then",
      }),
    ],
  ],
  [
    "a discriminated union",
    () =>
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("circle"), r: z.number() }),
        z.object({ kind: z.literal("rect"), w: z.number(), h: z.number() }),
      ]),
    [() => ({ kind: "circle", r: 1, extra: true }), () => ({ kind: "rect", w: 1, h: 2 })],
    [() => ({ kind: "circle", r: "1" }), () => ({ kind: "tri" }), () => 1],
  ],
  [
    "a frozen object",
    () => z.object({ a: z.string(), inner: z.object({ b: z.number() }) }).readonly(),
    [() => ({ a: "x", inner: { b: 1 }, extra: 1 })],
    [() => ({ a: 1, inner: {} })],
  ],
  [
    "a refinement and a transform",
    () =>
      z
        .object({ from: z.number(), to: z.number() })
        .refine((v) => v.from <= v.to, "from must not exceed to")
        .transform((v) => ({ ...v, span: v.to - v.from })),
    [() => ({ from: 1, to: 3 })],
    [() => ({ from: 3, to: 1 }), () => ({ from: "1", to: 3 })],
  ],
  [
    "a dynamic error map",
    () =>
      z.object({ a: z.string({ error: (issue) => `bad ${typeof issue.input}` }), n: z.number() }),
    [() => ({ a: "x", n: 1 })],
    [() => ({ a: 1, n: "x" })],
  ],
  [
    "a disjoint-key intersection",
    () => z.intersection(z.object({ a: z.string() }), z.object({ b: z.number(), c: z.boolean() })),
    [() => ({ c: true, b: 1, a: "x", extra: 1 })],
    [() => ({ a: 1, b: "x" }), () => []],
  ],
];

/** A parent built around the child, and the input that carries a child value to it. */
type Route = [
  label: string,
  build: (child: z.ZodType) => z.ZodType,
  wrap: (value: unknown) => unknown,
];

const ROUTES: Route[] = [
  ["the functional API on the schema itself", (child) => child, (value) => value],
  ["an array", (child) => z.array(child), (value) => [value, value]],
  [
    "an object member",
    (child) => z.object({ value: child, other: z.string() }),
    (value) => ({ value, other: "o", extra: 1 }),
  ],
  ["a strict object member", (child) => z.strictObject({ value: child }), (value) => ({ value })],
  ["optional", (child) => child.optional(), (value) => value],
  ["nullable", (child) => child.nullable(), (value) => value],
  ["a union", (child) => z.union([z.literal("other"), child]), (value) => value],
  ["readonly", (child) => child.readonly(), (value) => value],
  ["an array, frozen", (child) => z.array(child).readonly(), (value) => [value]],
  ["a record", (child) => z.record(z.string(), child), (value) => ({ a: value, b: value })],
  ["a tuple", (child) => z.tuple([child, z.number()]), (value) => [value, 1]],
  ["a map", (child) => z.map(z.string(), child), (value) => new Map([["k", value]])],
  ["a set", (child) => z.set(child), (value) => new Set([value])],
  ["lazy", (child) => z.lazy(() => child), (value) => value],
  ["a pipe", (child) => child.pipe(z.any()), (value) => value],
  [
    "a transform that hands the value on",
    (child) => child.transform((value) => ({ got: value })),
    (value) => value,
  ],
  [
    "a default",
    (child) => z.object({ v: child.optional() }).default({}),
    (value) => ({ v: value }),
  ],
  ["an intersection", (child) => z.intersection(child, z.any()), (value) => value],
];

describe("zod run — every route returns what zod returns", () => {
  const VARIANTS: [string, InstallOptions | undefined][] = [
    ["inline", undefined],
    ["lean", { mode: "lean" }],
    ["compact", { compact: true }],
  ];

  for (const [childLabel, make, accepted, rejected] of CHILDREN) {
    for (const [variant, options] of VARIANTS) {
      it(`${childLabel} (${variant})`, () => {
        for (const [routeLabel, build, wrap] of ROUTES) {
          const plain = build(make());
          const compiled = build(installOnto(make(), options));
          for (const value of [...accepted, ...rejected]) {
            expect(
              observe(compiled, () => wrap(value())),
              `${routeLabel}: ${JSON.stringify(value())}`,
            ).toStrictEqual(observe(plain, () => wrap(value())));
          }
        }
      });
    }
  }

  it("the same holds on an async parse", async () => {
    for (const [, make, accepted, rejected] of CHILDREN) {
      for (const [routeLabel, build, wrap] of ROUTES) {
        const plain = build(make());
        const compiled = build(installOnto(make()));
        for (const value of [...accepted, ...rejected]) {
          const settle = async (parent: z.ZodType): Promise<unknown> => {
            const input = wrap(value());
            try {
              const result = await z.safeParseAsync(parent, input);
              return result.success
                ? { data: result.data, identity: identityOf(input, result.data) }
                : { issues: result.error.issues };
            } catch (error) {
              return { threw: String(error) };
            }
          };
          expect(await settle(compiled), routeLabel).toStrictEqual(await settle(plain));
        }
      }
    }
  });

  it("per-call params still shape the issues, which are zod's own", () => {
    const params = { error: () => "per call", reportInput: true };
    for (const [, make, , rejected] of CHILDREN) {
      const plain = z.array(make());
      const compiled = z.array(installOnto(make()));
      for (const value of rejected) {
        const expected = observe(plain, () => [value()], params) as { issues: unknown[] };
        expect(observe(compiled, () => [value()], params)).toStrictEqual(expected);
        expect(expected.issues.length).toBeGreaterThan(0);
      }
    }
  });

  it("z.parse, z.decode and z.encode agree with zod too", () => {
    const plain = User();
    const compiled = installOnto(User());
    const good = { name: "Ada", email: "ada@example.com" };
    expect(z.parse(compiled, { ...good })).toStrictEqual(z.parse(plain, { ...good }));
    expect(z.decode(compiled, { ...good } as never)).toStrictEqual(
      z.decode(plain, { ...good } as never),
    );
    expect(z.encode(compiled, { ...good, role: "admin" })).toStrictEqual(
      z.encode(plain, { ...good, role: "admin" }),
    );
    expect(() => z.parse(compiled, { name: "A" })).toThrow(z.ZodError);
  });

  it("serves zod/mini's functional API, which is the only one it has", () => {
    const make = () =>
      zm.object({ id: zm.number(), tags: zm.array(zm.object({ t: zm.string() })) });
    const plain = make();
    const compiled = installOnto(make());
    expect(servesZod(compiled)).toBe(true);
    const runtime = countRuntime(compiled);
    for (const input of [{ id: 1, tags: [{ t: "a", x: 1 }] }, { id: "1", tags: [{}] }, null]) {
      const expected = zm.safeParse(plain, input);
      const actual = zm.safeParse(compiled, input);
      expect(actual.success).toBe(expected.success);
      expect(actual.data).toStrictEqual(expected.data);
      expect(actual.error?.issues).toStrictEqual(expected.error?.issues);
    }
    expect(runtime.calls).toBe(2);
  });
});

// ─── 3. The compiled path is the one taken, and only where it may be ────────

describe("zod run — when the validator answers and when it stands aside", () => {
  const valid = () => ({ name: "Ada", email: "ada@example.com" });
  const invalid = () => ({ name: "A", email: "nope" });

  it("answers a valid parse without zod's runtime, and hands an invalid one to it", () => {
    const compiled = installOnto(User());
    const runtime = countRuntime(compiled);

    expect(z.safeParse(compiled, valid()).success).toBe(true);
    expect(z.safeParse(z.array(compiled), [valid(), valid()]).success).toBe(true);
    expect(z.safeParse(compiled.optional(), valid()).success).toBe(true);
    expect(runtime.calls).toBe(0);

    expect(z.safeParse(compiled, invalid()).success).toBe(false);
    expect(runtime.calls).toBe(1);
  });

  it("answers an async parse when it calls no user code", async () => {
    const compiled = installOnto(User());
    const runtime = countRuntime(compiled);
    expect((await z.safeParseAsync(z.array(compiled), [valid()])).success).toBe(true);
    expect(runtime.calls).toBe(0);
  });

  it("leaves an async parse to zod when it does, so no callback runs twice", async () => {
    let calls = 0;
    const make = () =>
      z.object({ name: z.string() }).refine((value) => {
        calls++;
        return value.name !== "no";
      });
    const compiled = installOnto(make());
    expect(support(make())).toBe("sync");

    expect((await z.safeParseAsync(compiled, { name: "yes" })).success).toBe(true);
    expect(calls).toBe(1);
    // …while a synchronous parse of the same schema is the validator's.
    calls = 0;
    expect(z.safeParse(compiled, { name: "yes" }).success).toBe(true);
    expect(calls).toBe(1);
  });

  it("leaves an async parse to zod when a callback only reveals itself as async by its result", async () => {
    // Not an `async` function, so extraction cannot tell — the validator raises
    // zod's `$ZodAsyncError` on the promise, which is right for a synchronous
    // parse and would be a rejection here, where zod awaits the promise.
    const calls: string[] = [];
    const make = () =>
      z.object({ name: z.string() }).refine((value) => {
        calls.push(value.name);
        return Promise.resolve(value.name !== "no");
      });
    const plain = z.array(make());
    const compiled = z.array(installOnto(make()));
    expect(support(make())).toBe("sync");

    for (const name of ["yes", "no"]) {
      const expected = await z.safeParseAsync(plain, [{ name }]);
      calls.length = 0;
      const actual = await z.safeParseAsync(compiled, [{ name }]);
      expect(actual.success).toBe(expected.success);
      expect(actual.error?.issues).toStrictEqual(expected.error?.issues);
      expect(calls).toStrictEqual([name]);
    }
    expect(() => z.safeParse(compiled, [{ name: "yes" }])).toThrow(core.$ZodAsyncError);
  });

  it("stands aside for an encode, which the validator does not model", () => {
    const compiled = installOnto(User());
    const runtime = countRuntime(compiled);
    z.encode(compiled, { name: "Ada", email: "ada@example.com", role: "user" });
    expect(runtime.calls).toBeGreaterThan(0);
  });

  it("stands aside for a parse already marked as fallen back", () => {
    const compiled = installOnto(User());
    const runtime = countRuntime(compiled);
    const marked = { async: false, [FALLBACK]: true };
    expect(internals(compiled).run({ value: valid(), issues: [] }, marked).issues).toHaveLength(0);
    expect(runtime.calls).toBe(1);
    expect(marked[FALLBACK]).toBe(true);
  });

  it("marks a parse it fails while zod redoes it, and only for that long", () => {
    const compiled = installOnto(User());
    const zod = internals(compiled);
    const original = zod.parse;
    const seen: unknown[] = [];
    zod.parse = (payload, ctx) => {
      seen.push((ctx as Record<PropertyKey, unknown>)[FALLBACK]);
      return original(payload, ctx);
    };

    const ctx: Record<PropertyKey, unknown> = { async: false };
    expect(zod.run({ value: invalid(), issues: [] }, ctx).issues.length).toBeGreaterThan(0);
    expect(seen).toStrictEqual([true]);
    expect(ctx[FALLBACK]).toBe(false);

    // A parse that succeeds leaves the context exactly as it found it.
    const clean: Record<PropertyKey, unknown> = { async: false };
    zod.run({ value: valid(), issues: [] }, clean);
    expect(Reflect.ownKeys(clean)).toStrictEqual(["async"]);
  });

  it("answers for the union member that accepts what an earlier one refused", () => {
    const first = installOnto(z.object({ kind: z.literal("a"), a: z.string() }));
    const second = installOnto(z.object({ kind: z.literal("b"), b: z.number() }));
    const firstRuntime = countRuntime(first);
    const secondRuntime = countRuntime(second);

    const result = z.safeParse(z.union([first, second]), { kind: "b", b: 1, extra: true });
    expect(result.data).toStrictEqual({ kind: "b", b: 1 });
    // Zod redid the member that failed, for its issues; the other was the validator's.
    expect(firstRuntime.calls).toBe(1);
    expect(secondRuntime.calls).toBe(0);
  });

  it("keeps an async parse marked while zod's answer is still pending", async () => {
    // Zod's answer is a promise when something in the schema's subtree only
    // settles later: the runtime has not finished there when `run` returns, so
    // the mark has to outlive the call. Stood in for by a parser that defers.
    const compiled = installOnto(z.object({ id: z.number() }));
    const zod = internals(compiled);
    const original = zod.parse;
    zod.parse = (payload, ctx) => Promise.resolve(original(payload, ctx)) as never;

    const ctx: Record<PropertyKey, unknown> = { async: true };
    const answer = zod.run({ value: { id: "x" }, issues: [] }, ctx) as unknown;
    expect(answer).toBeInstanceOf(Promise);
    expect(ctx[FALLBACK]).toBe(true);
    expect(((await answer) as Payload).issues.length).toBeGreaterThan(0);
  });

  it("stands aside for a memoized back-edge, as zod's own compiled wrapper does", () => {
    // Pinned to the live zod: `isBackEdge` is what `__zcZr` asks, and this is
    // the state zod's memoizer keeps on the context for it to read.
    const compiled = installOnto(User());
    const runtime = countRuntime(compiled);
    const value = valid();
    const ctx = { async: false, "~memo": { buckets: new Map(), backEdges: new Set([value]) } };
    expect(core.isBackEdge(ctx as never, value)).toBe(true);

    internals(compiled).run({ value, issues: [] }, ctx);
    expect(runtime.calls).toBe(1);
  });

  it("stands aside when called with no context at all", () => {
    // Zod's own traversal always passes one; a schema whose members read it
    // throws without. This one does not, so the bare call works on zod and has
    // to keep working — through zod — on the compiled schema.
    const make = () => z.object({ a: z.string() });
    const plain = internals(make()).run({ value: { a: "x", extra: 1 }, issues: [] });
    const compiled = installOnto(make());
    const runtime = countRuntime(compiled);
    const payload = internals(compiled).run({ value: { a: "x", extra: 1 }, issues: [] });
    expect(payload).toStrictEqual(plain);
    expect(runtime.calls).toBe(1);
  });

  it("follows zod's memoizer when it swaps a container's parser after the first parse", async () => {
    // A schema with no checks has `run` and `parse` as one function, and zod
    // replaces it on the first runtime parse of a non-recursive container. A
    // wrapper still holding the old one would keep memoizing: the same input
    // object met three times in one parse would come back as ONE output object.
    const make = () => z.object({ name: z.string() }).refine((value) => value.name !== "no");
    const plain = z.array(make());
    const compiled = z.array(installOnto(make()));
    const shared = { name: "yes" };

    for (let round = 0; round < 3; round++) {
      // An async parse of a "sync" schema is the route that reaches zod's runtime on VALID input.
      const expected = await z.safeParseAsync(plain, [shared, shared, shared]);
      const actual = await z.safeParseAsync(compiled, [shared, shared, shared]);
      expect(actual.data).toStrictEqual(expected.data);
      const [first, second, third] = actual.data as object[];
      expect(first).not.toBe(second);
      expect(second).not.toBe(third);
      expect(z.safeParse(compiled, [{ name: "no" }]).error?.issues).toStrictEqual(
        z.safeParse(plain, [{ name: "no" }]).error?.issues,
      );
    }
  });
});

// ─── 4. User callbacks: never more than the validator's call and zod's ──────

describe("zod run — a callback runs at most twice on invalid input", () => {
  function counted() {
    const calls: string[] = [];
    const make = () =>
      z.object({ id: z.string() }).refine((value) => {
        calls.push(value.id);
        return !value.id.startsWith("bad");
      });
    return { calls, make };
  }

  it("once per value on valid input, like zod", () => {
    const { calls, make } = counted();
    const compiled = z.array(installOnto(make()));
    expect(z.safeParse(compiled, [{ id: "a" }, { id: "b" }]).success).toBe(true);
    expect(calls).toStrictEqual(["a", "b"]);
  });

  it("twice for the value that fails, once for those zod then parses alone", () => {
    const { calls, make } = counted();
    const compiled = z.array(installOnto(make()));
    expect(z.safeParse(compiled, [{ id: "a" }, { id: "bad" }, { id: "c" }]).success).toBe(false);
    // "a" by the validator; "bad" by the validator and then by zod; "c" by the
    // validator again, the mark having come off with zod's answer.
    expect(calls).toStrictEqual(["a", "bad", "bad", "c"]);
  });

  it("holds through a compiled schema nested in a compiled schema under zod", () => {
    const { calls, make } = counted();
    const inner = installOnto(make());
    const middle = installOnto(z.object({ inner }));
    expect(servesZod(inner)).toBe(true);
    expect(servesZod(middle)).toBe(true);

    expect(z.safeParse(z.array(middle), [{ inner: { id: "bad" } }]).success).toBe(false);
    expect(calls).toStrictEqual(["bad", "bad"]);
  });

  it("holds when the schema's own error path asks zod about the schema itself", () => {
    // A dynamic error map on the ROOT: the verdict is compiled, the issues come
    // from zod running this very schema — whose `_zod.run` is now the compiled
    // wrapper. Unmarked, that call would run the validator (and the callback) a
    // second time before falling back to zod for the third.
    const calls: string[] = [];
    const make = () =>
      z.object(
        {
          id: z.string().refine((value) => {
            calls.push(value);
            return false;
          }, "refused"),
        },
        { error: (issue) => `dynamic ${issue.code}` },
      );
    const plain = make();
    const compiled = installOnto(make());
    expect(servesZod(compiled)).toBe(true);

    const expected = plain.safeParse({ id: "x" });
    calls.length = 0;
    const actual = compiled.safeParse({ id: "x" });
    expect(actual.error?.issues).toStrictEqual(expected.error?.issues);
    expect(calls).toStrictEqual(["x", "x"]);
  });

  it("holds for compact output, whose error path is zod's whole parse", () => {
    const calls: string[] = [];
    const make = () =>
      z.string().refine((value) => {
        calls.push(value);
        return false;
      }, "refused");
    const plain = make();
    const compiled = installOnto(make(), { compact: true });
    expect(servesZod(compiled)).toBe(true);

    const expected = plain.safeParse("x");
    calls.length = 0;
    const actual = compiled.safeParse("x");
    expect(actual.error?.issues).toStrictEqual(expected.error?.issues);
    expect(calls).toStrictEqual(["x", "x"]);
  });
});

// ─── 5. Other things that wrap `_zod.run` ───────────────────────────────────

describe("zod run — alongside zod's own wrappers", () => {
  const make = () => z.object({ a: z.string(), n: z.number().optional() });

  it("publishes zod's runtime as `__originalRun`, the way zod's wrappers do", () => {
    const schema = make();
    const runtime = internals(schema).run;
    installOnto(schema);
    expect(internals(schema).run).not.toBe(runtime);
    expect(internals(schema).run.__originalRun).toBe(runtime);
  });

  it("unwraps past a wrapper that was there first (zod/compile's shim)", () => {
    const schema = make();
    const runtime = internals(schema).run;
    const shim: Run = (payload, ctx) => runtime(payload, ctx);
    shim.__originalRun = runtime;
    internals(schema).run = shim;

    installOnto(schema);
    expect(internals(schema).run.__originalRun).toBe(runtime);
  });

  it("two exports aliasing one schema leave one wrapper over zod's runtime", () => {
    const schema = make();
    const runtime = internals(schema).run;
    installLikeProduction([schema, schema]);
    expect(internals(schema).run.__originalRun).toBe(runtime);
    expect(z.safeParse(schema, { a: "x", extra: 1 }).data).toStrictEqual({ a: "x" });
    expect(z.safeParse(schema, { a: 1 }).success).toBe(false);
  });

  it("a schema compiled here can still be handed to z.compile", () => {
    const plain = make();
    const twice = z.compile(installOnto(make()));
    for (const input of [{ a: "x", n: 1, extra: true }, { a: 1 }, null]) {
      const expected = plain.safeParse(input);
      const actual = twice.safeParse(input);
      expect(actual.success).toBe(expected.success);
      expect(actual.data).toStrictEqual(expected.data);
      expect(actual.error?.issues).toStrictEqual(expected.error?.issues);
    }
  });

  it("a schema compiled by z.compile nested in one compiled here keeps the callback bound", () => {
    const calls: string[] = [];
    const leaf = z.compile(
      z.object({ id: z.string() }).refine((value) => {
        calls.push(value.id);
        return false;
      }),
    );
    const parent = installOnto(z.object({ leaf }));
    expect(servesZod(parent)).toBe(true);
    expect(z.safeParse(z.array(parent), [{ leaf: { id: "x" } }]).success).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("jit() installs it with everything else", () => {
    const eager = jit(make(), { eager: true });
    expect(servesZod(eager)).toBe(true);

    const lazy = jit(make());
    expect(servesZod(lazy)).toBe(false);
    expect(lazy.safeParse({ a: "x" }).success).toBe(true);
    expect(servesZod(lazy)).toBe(true);
    const runtime = countRuntime(lazy);
    expect(z.safeParse(z.array(lazy), [{ a: "x" }]).success).toBe(true);
    expect(runtime.calls).toBe(0);
  });
});

// ─── 6. Generated schemas ────────────────────────────────────────────────────

/**
 * The corpus above is shapes someone thought of. These are not: seeded
 * generators build the schema, a twin of it is compiled in place, and both are
 * parsed through zod's own routes. Whatever the generator produced — and
 * whether or not its validator turned out to qualify — the two have to be
 * indistinguishable: same data, same issues, same sharing with the input, same
 * frozen objects, and an input nobody wrote to.
 */
const FUZZ_ROUTES: Route[] = [
  ["the functional API", (child) => child, (value) => value],
  ["an array", (child) => z.array(child), (value) => [value, value]],
  ["an object member", (child) => z.object({ v: child }), (value) => ({ v: value, extra: 1 })],
  ["readonly", (child) => child.readonly(), (value) => value],
  ["optional", (child) => child.optional(), (value) => value],
];

function expectIndistinguishable(build: () => Gen, options?: InstallOptions): boolean {
  let served = false;
  for (const [routeLabel, route, wrap] of FUZZ_ROUTES) {
    const plain = build();
    const compiled = build();
    installOnto(compiled.schema, options);
    served = servesZod(compiled.schema);
    const plainParent = route(plain.schema);
    const compiledParent = route(compiled.schema);
    const inputs: [string, unknown][] = [
      ["good", plain.good()],
      ["bad", plain.bad()],
      ...FOREIGN.map((value): [string, unknown] => [`foreign ${shapeOf(value)}`, value]),
    ];
    for (const [inputLabel, value] of inputs) {
      // ONE input for both parses: a generated value can hold things no second
      // copy would equal (a fresh symbol, a File), and neither parse may leave
      // a mark on it for the other to find — each checks that for itself.
      const input = wrap(value);
      expect(
        observe(compiledParent, () => input),
        `${routeLabel}, ${inputLabel}`,
      ).toStrictEqual(observe(plainParent, () => input));
    }
  }
  return served;
}

describe("zod run — the structural fuzz, through zod", () => {
  let served = 0;
  for (let seed = 1; seed <= 250; seed++) {
    it(`seed ${seed}`, () => {
      if (expectIndistinguishable(() => buildSeed(seed))) served++;
    });
  }

  it("reached the compiled path for a real share of them", () => {
    // Most generated schemas hold a container the compiler passes through, and
    // are rightly left to zod; this is the floor on the ones that were not.
    expect(served).toBeGreaterThan(40);
  });
});

/**
 * A generator of schemas that DO qualify: every container in them is one the
 * build pass allocates. Each is asserted to have been installed, so the suite
 * below is all compiled path.
 */
const REBUILT_LEAVES: (() => Gen)[] = [
  () => ({ schema: z.string().min(2).max(6), good: () => "abc", bad: () => "a" }),
  () => ({ schema: z.number().int(), good: () => 7, bad: () => 1.5 }),
  () => ({ schema: z.boolean(), good: () => false, bad: () => "false" }),
  () => ({ schema: z.enum(["a", "b"]), good: () => "b", bad: () => "c" }),
  () => ({ schema: z.literal(1), good: () => 1, bad: () => 2 }),
  () => ({ schema: z.date(), good: () => new Date(1), bad: () => "then" }),
  () => ({ schema: z.email(), good: () => "a@b.co", bad: () => "a@b" }),
  () => ({ schema: z.url(), good: () => " https://example.com/a ", bad: () => "example" }),
  () => ({ schema: z.coerce.number(), good: () => "5", bad: () => "x" }),
  () => ({ schema: z.string().trim().toLowerCase(), good: () => " Ab ", bad: () => 1 }),
  () => ({ schema: z.string().default("d"), good: () => undefined, bad: () => 1 }),
  () => ({ schema: z.string().optional(), good: () => undefined, bad: () => 1 }),
  () => ({ schema: z.number().nullable(), good: () => null, bad: () => "1" }),
  () => ({ schema: z.any(), good: () => ({ kept: ["by", "reference"] }), bad: () => 1 }),
  () => ({ schema: z.stringbool(), good: () => "yes", bad: () => "perhaps" }),
  () => ({ schema: z.string().transform((v) => v.length), good: () => "abc", bad: () => 1 }),
  () => ({ schema: z.number().refine((v) => v > 0, "positive"), good: () => 3, bad: () => -3 }),
  () => ({ schema: z.custom<string>((v) => typeof v === "string"), good: () => "s", bad: () => 1 }),
];

function rebuiltObject(r: () => number, depth: number): Gen {
  const count = 1 + Math.floor(r() * 4);
  const parts = Array.from({ length: count }, (_unused, index) => {
    const nested = depth > 0 && r() < 0.45;
    const gen = nested
      ? rebuilt(r, depth - 1)
      : (REBUILT_LEAVES[Math.floor(r() * REBUILT_LEAVES.length)] as () => Gen)();
    return [`k${index}`, gen] as const;
  });
  // The LAST member is the one made invalid, so every member before it has
  // already been validated — and built — when the validator gives up.
  const last = parts.length - 1;
  return {
    schema: z.object(Object.fromEntries(parts.map(([key, gen]) => [key, gen.schema]))),
    good: () => ({
      ...Object.fromEntries(parts.map(([key, gen]) => [key, gen.good()])),
      unknown: 1,
    }),
    bad: () =>
      Object.fromEntries(
        parts.map(([key, gen], index) => [key, index === last ? gen.bad() : gen.good()]),
      ),
  };
}

function rebuilt(r: () => number, depth: number): Gen {
  const inner = rebuiltObject(r, depth);
  if (depth <= 0) return inner;
  switch (Math.floor(r() * 9)) {
    case 0:
      return {
        schema: z.array(inner.schema),
        good: () => [inner.good(), inner.good()],
        bad: () => [inner.good(), inner.bad()],
      };
    case 1:
      return {
        schema: z.tuple([inner.schema, z.number()]),
        good: () => [inner.good(), 1],
        bad: () => [inner.bad(), 1],
      };
    case 2:
      return { schema: z.union([z.string(), inner.schema]), good: inner.good, bad: inner.bad };
    case 3: {
      const other = rebuiltObject(r, depth - 1);
      return {
        schema: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a"), value: inner.schema }),
          z.object({ kind: z.literal("b"), value: other.schema }),
        ]),
        good: () =>
          r() < 0.5 ? { kind: "a", value: inner.good() } : { kind: "b", value: other.good() },
        bad: () => ({ kind: "a", value: inner.bad() }),
      };
    }
    case 4:
      return { schema: inner.schema.readonly(), good: inner.good, bad: inner.bad };
    case 5:
      return {
        schema: inner.schema.refine((value) => value !== null, "never fails"),
        good: inner.good,
        bad: inner.bad,
      };
    case 6:
      return {
        schema: inner.schema.transform((value) => ({ wrapped: value })),
        good: inner.good,
        bad: inner.bad,
      };
    case 7:
      return { schema: inner.schema.nullable(), good: () => null, bad: inner.bad };
    default:
      return inner;
  }
}

describe("zod run — generated rebuilding schemas, all on the compiled path", () => {
  const VARIANTS: [string, InstallOptions | undefined][] = [
    ["inline", undefined],
    ["lean", { mode: "lean" }],
    ["compact", { compact: true }],
  ];
  for (let seed = 1; seed <= 150; seed++) {
    const [variant, options] = VARIANTS[seed % VARIANTS.length] as (typeof VARIANTS)[number];
    it(`seed ${seed} (${variant})`, async () => {
      // The discriminated-union generator draws from the stream when it builds
      // an input, so each twin gets a stream of its own from the same seed.
      const build = (): Gen => rebuilt(rng(seed * 104_729), 1 + (seed % 3));
      expect(expectIndistinguishable(build, options), "should qualify").toBe(true);

      // The same on an async parse, where a schema calling user code steps aside.
      const plain = build();
      const compiled = build();
      installOnto(compiled.schema, options);
      for (const pick of ["good", "bad"] as const) {
        const input = [plain[pick]()];
        const settle = async (gen: Gen): Promise<unknown> => {
          const before = shapeOf(input);
          const result = await z.safeParseAsync(z.array(gen.schema), input);
          return result.success
            ? {
                data: result.data,
                identity: identityOf(input, result.data),
                untouched: untouched(input, before),
              }
            : { issues: result.error.issues, untouched: untouched(input, before) };
        };
        expect(await settle(compiled), pick).toStrictEqual(await settle(plain));
      }
    });
  }
});
