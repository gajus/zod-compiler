/**
 * Where an issue's message comes from when nothing was baked into it.
 *
 * Zod resolves it in `finalizeIssue`, in order: the schema's own `error` option,
 * the per-call `ctx.error`, `config.customError`, `config.localeError`, then
 * "Invalid input". The compiled path bakes the first link at build time and
 * resolves the two config links at `.error`-read time.
 *
 * It used to snapshot `config().localeError` into `__zcMsg` at module init,
 * which broke two things silently: `customError` was never consulted at all, and
 * a `z.config()` running AFTER the schema module was imported — the normal order
 * when an entry point configures a locale and imports schemas — was ignored.
 *
 * `ctx.error` and `reportInput` remain unsupported: they arrive per call, so
 * `safeParse` would have to carry them, and that entry point has no room (an
 * unused second parameter alone measured ~12% on every parse).
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import * as zm from "zod/mini";
import { generateValidator } from "#src/core/codegen/index.js";
import { resolveCheckMessage } from "#src/core/extract/checks.js";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import { compileLikeProduction, expectLeanParity, expectParity } from "./parity-harness.js";

/** First issue's message from the compiled validator. */
function message(schema: z.ZodType, input: unknown, name: string): string | undefined {
  const result = compileLikeProduction(schema, name)(input);
  return result.success
    ? undefined
    : (result.error.issues[0] as { message?: string } | undefined)?.message;
}

afterEach(() => {
  z.config({ customError: undefined, localeError: undefined });
});

describe("error maps — resolved at .error-read time, not module init", () => {
  it("honours a customError installed after the schema was compiled", () => {
    const schema = z.object({ a: z.string().min(3) });
    const compiled = compileLikeProduction(schema, "cfgLate");
    z.config({ customError: () => "CUSTOM" });
    const result = compiled({ a: "x" });
    expect(result.success).toBe(false);
    expect((result as { error: { issues: { message: string }[] } }).error.issues[0]?.message).toBe(
      "CUSTOM",
    );
  });

  it("honours a localeError installed after the schema was compiled", () => {
    const schema = z.string().min(3);
    const compiled = compileLikeProduction(schema, "locLate");
    z.config({ localeError: () => "LOCALE" });
    const result = compiled("x");
    expect((result as { error: { issues: { message: string }[] } }).error.issues[0]?.message).toBe(
      "LOCALE",
    );
  });

  it("prefers customError over localeError, as zod does", () => {
    z.config({ customError: () => "CUSTOM", localeError: () => "LOCALE" });
    expect(message(z.string().min(3), "x", "prec")).toBe("CUSTOM");
  });

  it("falls through to localeError when customError returns undefined", () => {
    z.config({ customError: () => undefined, localeError: () => "LOCALE" });
    expect(message(z.string().min(3), "x", "fall")).toBe("LOCALE");
  });

  it("unwraps a map that returns an object", () => {
    z.config({ customError: () => ({ message: "OBJ" }) });
    expect(message(z.string().min(3), "x", "obj")).toBe("OBJ");
  });

  it('falls back to "Invalid input" when every map declines', () => {
    z.config({ customError: () => undefined, localeError: () => undefined });
    expect(message(z.string().min(3), "x", "none")).toBe("Invalid input");
  });

  it("leaves a baked schema-level message alone", () => {
    // The schema's own `error` wins over both config maps — it is baked into the
    // issue at build time, so the resolver never runs for it.
    z.config({ customError: () => "CUSTOM" });
    expect(message(z.string().min(3, "BAKED"), "x", "baked")).toBe("BAKED");
  });

  it("matches zod for every map combination", () => {
    const cases: [string, () => void][] = [
      ["none", () => {}],
      ["custom only", () => z.config({ customError: () => "C" })],
      ["locale only", () => z.config({ localeError: () => "L" })],
      ["both", () => z.config({ customError: () => "C", localeError: () => "L" })],
      ["custom declines", () => z.config({ customError: () => undefined, localeError: () => "L" })],
    ];
    for (const [label, setup] of cases) {
      z.config({ customError: undefined, localeError: undefined });
      setup();
      const schema = z.object({ a: z.string().min(3), b: z.number().int() });
      const input = { a: "x", b: 1.5 };
      const zodMessages = (schema.safeParse(input).error?.issues ?? []).map((i) => i.message);
      const result = compileLikeProduction(schema, `combo${label.replace(/\W/g, "")}`)(input);
      const compiledMessages = result.success
        ? []
        : (result.error.issues as { message: string }[]).map((i) => i.message);
      expect(compiledMessages, label).toStrictEqual(zodMessages);
    }
  });
});

/**
 * The first link of the chain — the schema's own `error` — when it is a
 * FUNCTION.
 *
 * Zod calls it on every failure and reports what it returns then. The compiler
 * bakes a message at build time, which is only the same thing when the map's
 * answer is fixed. It used to decide that by calling the map with a tracking
 * proxy and checking that the issue was never read — and a translation lookup
 * never reads it either: `{ error: () => t("required") }` was evaluated once,
 * at compile time, and every later failure reported the locale the BUILD ran
 * in. Zod answered "Erforderlich" after a switch to German; the compiled
 * schema kept answering "Required".
 */
describe("error maps — a schema's own error function answers when the failure is reported", () => {
  type Locale = "de" | "en";
  const translations: Record<Locale, { required: string }> = {
    de: { required: "Erforderlich" },
    en: { required: "Required" },
  };
  let locale: Locale = "en";
  let active = translations.en;
  const t = (key: "required"): string => translations[locale][key];
  const setLocale = (next: Locale): void => {
    locale = next;
    active = translations[next];
  };

  afterEach(() => setLocale("en"));

  // Every map here ignores its issue, which is what made it look constant.
  const LOOKUPS: [string, () => z.ZodType, unknown][] = [
    ["a call, on the schema", () => z.string({ error: () => t("required") }), 1],
    ["a call, on a check", () => z.string().min(3, { error: () => t("required") }), "x"],
    [
      "a call, on a refinement",
      () => z.string().refine(() => false, { error: () => t("required") }),
      "x",
    ],
    ["a call, on a number check", () => z.number().int({ error: () => t("required") }), 1.5],
    ["a call, on a format", () => z.email({ error: () => t("required") }), "x"],
    ["a call, on a container", () => z.object({}, { error: () => t("required") }), 1],
    // The types whose extractors classify their own checks.
    [
      "a call, on a date check",
      () => z.date().min(new Date("2020-01-01"), { error: () => t("required") }),
      new Date(0),
    ],
    ["a call, on a bigint check", () => z.bigint().min(1n, { error: () => t("required") }), 0n],
    [
      "a call, on a set check",
      () => z.set(z.string()).min(1, { error: () => t("required") }),
      new Set(),
    ],
    ["a keyed lookup", () => z.string({ error: () => translations[locale].required }), 1],
    ["a property of a swapped dictionary", () => z.string({ error: () => active.required }), 1],
    ["string building", () => z.string({ error: () => `${t("required")}` }), 1],
    ["a returned object", () => z.string({ error: () => ({ message: t("required") }) }), 1],
    [
      "a block body",
      () =>
        z.string({
          error: () => {
            const resolved = t("required");
            return resolved;
          },
        }),
      1,
    ],
    [
      "a method",
      () =>
        z.string({
          error() {
            return t("required");
          },
        }),
      1,
    ],
    [
      "a default parameter",
      () => z.string({ error: ((_issue: unknown, resolved = t("required")) => resolved) as never }),
      1,
    ],
    ["nested in an object", () => z.object({ a: z.string({ error: () => t("required") }) }), {}],
  ];

  for (const [label, make, bad] of LOOKUPS) {
    it(`${label}: follows a locale switched after the schema was compiled`, () => {
      const plain = make();
      const compiled = compileLikeProduction(make(), "i18n");
      setLocale("de");

      const expected = plain.safeParse(bad).error?.issues.map((issue) => issue.message);
      expect(expected).toStrictEqual(["Erforderlich"]);
      const result = compiled(bad);
      expect(result.success).toBe(false);
      expect(
        result.success ? [] : (result.error.issues as { message: string }[]).map((i) => i.message),
      ).toStrictEqual(expected);
    });
  }

  it("is not run while the schema is being compiled", () => {
    let calls = 0;
    const schema = z.object({
      a: z.string({
        error: () => {
          calls++;
          return t("required");
        },
      }),
      b: z.number().min(1, { error: () => String(++calls) }),
    });

    compileLikeProduction(schema, "notRun");
    expect(calls).toBe(0);
  });
});

/**
 * The other side of the same test: a message that IS fixed keeps being baked,
 * so the schema keeps its compiled path. Zod turns every string message into a
 * closure (`normalizeParams`), and the compiler recognizes those closures by
 * their shape — which means a zod release that spells them differently would
 * silently turn every custom message into a Zod fallback. These pin the shapes
 * against the installed zod, so that upgrade fails here instead.
 */
describe("error maps — a fixed message is still baked", () => {
  const errorOf = (schema: unknown): unknown =>
    (schema as { _zod: { def: { error?: unknown } } })._zod.def.error;
  const checkErrorOf = (schema: unknown): unknown =>
    (schema as { _zod: { def: { checks: { _zod: { def: { error?: unknown } } }[] } } })._zod.def
      .checks[0]?._zod.def.error;

  const ZOD_WRAPPERS: [string, unknown][] = [
    ['z.string("m")', errorOf(z.string("m"))],
    ['z.string({ error: "m" })', errorOf(z.string({ error: "m" }))],
    ['z.string({ message: "m" })', errorOf(z.string({ message: "m" }))],
    ['z.email("m")', errorOf(z.email("m"))],
    ['z.object({}, "m")', errorOf(z.object({}, "m"))],
    ['.min(3, "m")', checkErrorOf(z.string().min(3, "m"))],
    ['.min(3, { error: "m" })', checkErrorOf(z.string().min(3, { error: "m" }))],
    ['.min(3, { message: "m" })', checkErrorOf(z.string().min(3, { message: "m" }))],
    ['.refine(fn, "m")', checkErrorOf(z.string().refine(() => true, "m"))],
    [
      '.refine(fn, { message: "m" })',
      checkErrorOf(z.string().refine(() => true, { message: "m" })),
    ],
    ['zod/mini string("m")', errorOf(zm.string("m"))],
    [
      'zod/mini minLength(3, { error: "m" })',
      checkErrorOf(zm.string().check(zm.minLength(3, { error: "m" }))),
    ],
  ];

  for (const [label, error] of ZOD_WRAPPERS) {
    it(`zod's own wrapper for ${label}`, () => {
      expect(typeof error).toBe("function");
      expect(resolveCheckMessage(error)).toStrictEqual({ kind: "static", message: "m" });
    });
  }

  it("a hand-written map that returns a literal", () => {
    expect(resolveCheckMessage(() => "m")).toStrictEqual({ kind: "static", message: "m" });
    expect(resolveCheckMessage(() => ({ message: "m" }))).toStrictEqual({
      kind: "static",
      message: "m",
    });
    expect(resolveCheckMessage((_issue: unknown) => "m")).toStrictEqual({
      kind: "static",
      message: "m",
    });
    expect(resolveCheckMessage(() => undefined)).toStrictEqual({ kind: "none" });
  });

  it("keeps the schema compiled rather than delegating it to zod", () => {
    const refs: RefEntry[] = [];
    const ir = extractSchema(
      z.object({ a: z.string("bad a").min(3, "short a"), b: z.number({ error: () => "bad b" }) }),
      refs,
    );

    expect(ir).toMatchObject({
      type: "object",
      properties: {
        a: { type: "string", typeMessage: "bad a", checks: [{ message: "short a" }] },
        b: { type: "number", typeMessage: "bad b" },
      },
    });
    expect(refs).toStrictEqual([]);
  });
});

/**
 * What a dynamic error map costs the schema that carries it: its compiled
 * ISSUES, and nothing else.
 *
 * A map decides a message. It cannot change which inputs a node accepts or what
 * the node yields for them, so the node compiles exactly as it would without
 * one, and only the walk that produces issues — cold, and deferred until
 * `.error` is read — is handed to the retained zod schema, which calls the map
 * on the failure it is reporting. Such a node used to be delegated WHOLE, which
 * cost the enclosing schema its fast path, its build path and its `.is()` over
 * what is dead code on valid input.
 */
describe("error maps — a dynamic map leaves the hot path compiled", () => {
  const dynamic = (issue: { code?: string; input?: unknown }): string =>
    issue.input === undefined ? "Required" : `Bad ${String(issue.code)}`;

  const extract = (schema: unknown): { ir: ReturnType<typeof extractSchema>; refs: RefEntry[] } => {
    const refs: RefEntry[] = [];
    return { ir: extractSchema(schema, refs), refs };
  };

  it("wraps the node, not its parent, and keeps what was extracted beneath", () => {
    const { ir, refs } = extract(
      z.object({ a: z.string({ error: dynamic }).min(3), b: z.number() }),
    );

    expect(ir).toMatchObject({
      type: "object",
      properties: {
        a: { type: "zodDelegate", refIndex: 0, inner: { type: "string", checks: [{}] } },
        b: { type: "number" },
      },
    });
    expect(refs.map((ref) => ref.accessPath)).toStrictEqual(['.shape["a"]']);
  });

  it("treats a map on a CHECK like one on the schema, and compiles the check without a message", () => {
    const { ir } = extract(z.string().min(3, { error: dynamic }).max(9, "long"));

    expect(ir).toMatchObject({
      type: "zodDelegate",
      inner: {
        type: "string",
        checks: [
          { kind: "min_length", minimum: 3 },
          { kind: "max_length", maximum: 9, message: "long" },
        ],
      },
    });
    expect(
      (ir as { inner: { checks: { message?: string }[] } }).inner.checks[0]?.message,
    ).toBeUndefined();
  });

  it("covers the types whose extractors classify their own checks", () => {
    const shapes: [string, unknown][] = [
      ["date", z.date().min(new Date(0), { error: dynamic })],
      ["bigint", z.bigint().min(1n, { error: dynamic })],
      ["set", z.set(z.string()).min(1, { error: dynamic })],
      ["number", z.int({ error: dynamic })],
      ["array", z.array(z.string()).min(1, { error: dynamic })],
      ["object", z.object({ a: z.string() }, { error: dynamic })],
    ];
    for (const [type, schema] of shapes) {
      expect(extract(schema).ir, type).toMatchObject({ type: "zodDelegate", inner: { type } });
    }
  });

  it("stays compiled under .readonly(), which sees through to the value it freezes", () => {
    // A primitive: the wrapper compiles away, as it does without a map.
    expect(extract(z.string({ error: dynamic }).readonly()).ir).toMatchObject({
      type: "readonly",
      inner: { type: "zodDelegate", inner: { type: "string" } },
    });
    // A stripping object: rebuilt by both walks, so the freeze is emitted.
    const frozen = z.object({ a: z.string() }, { error: dynamic }).readonly();
    expect(extract(frozen).ir).toMatchObject({
      type: "readonly",
      freeze: true,
      inner: { type: "zodDelegate", inner: { type: "object" } },
    });
    const input = { a: "x", extra: 1 };
    const result = compileLikeProduction(frozen, "frozenDelegate")(input);
    expect(result).toMatchObject({ success: true, data: { a: "x" } });
    expect(Object.isFrozen(result.success ? result.data : undefined)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expectParity(frozen, [input, { a: 1 }, null]);
  });

  it("falls back whole when there is no ref table to hold the retained schema", () => {
    expect(extractSchema(z.string({ error: dynamic }))).toMatchObject({ type: "fallback" });
  });

  it("keeps the build path and the .is() predicate, with zod reached only from the issue walk", () => {
    const { ir, refs } = extract(z.object({ a: z.string({ error: dynamic }), b: z.number() }));
    const generated = generateValidator(ir, "hot", { refCount: refs.length });
    const hosted = generated.code.split("\n");
    const build = hosted.filter((line) => line.startsWith("function __vb_"));
    const fast = hosted.filter((line) => line.startsWith("function __fc_"));

    expect(build).toHaveLength(1);
    expect(fast).toHaveLength(1);
    expect(generated.isFnName).toMatch(/^__fc_/);
    // `__zcRd` is the helper that runs a retained schema.
    expect(build.join("") + fast.join("") + generated.functionDef).not.toContain("__zcRd(");
    expect(generated.code).toContain("__zcRd(");
  });

  it("does not run zod at all for input the schema accepts", () => {
    const field = z.string({ error: dynamic });
    const schema = z.object({ a: field, b: z.number() });
    const compiled = compileLikeProduction(schema, "untouched");
    let runs = 0;
    const internals = field._zod as unknown as { run: (...args: unknown[]) => unknown };
    const run = internals.run;
    internals.run = (...args) => {
      runs++;
      return run(...args);
    };

    expect(compiled({ a: "x", b: 1 })).toMatchObject({ success: true, data: { a: "x", b: 1 } });
    expect(runs).toBe(0);
    // Rejection alone does not either: the issue walk is deferred behind `.error`.
    const rejected = compiled({ a: 1, b: 1 });
    expect(rejected.success).toBe(false);
    expect(runs).toBe(0);
    expect(rejected.success ? [] : rejected.error.issues).toMatchObject([
      { code: "invalid_type", path: ["a"], message: "Bad invalid_type" },
    ]);
    expect(runs).toBe(1);
  });

  // Whole issue lists against zod, with the map in every position a node can
  // hold one and under every wrapper that has to carry the delegate through.
  const POSITIONS: [string, () => z.ZodType, unknown[]][] = [
    [
      "a field",
      () => z.object({ a: z.string({ error: dynamic }), b: z.number() }),
      [{ a: "x", b: 1 }, { a: 1, b: 1 }, { b: 1 }, { a: "x" }, {}, null, 1],
    ],
    [
      "the root object",
      () => z.object({ a: z.string(), b: z.number() }, { error: dynamic }),
      [{ a: "x", b: 1 }, { a: 1 }, {}, null, undefined, "s", []],
    ],
    [
      "a check",
      () =>
        z.object({
          a: z.string().min(3, { error: (issue) => `min ${String(issue.minimum)}` }),
          n: z.number().max(5, { error: (issue) => `max ${String(issue.maximum)}` }),
        }),
      [{ a: "abcd", n: 1 }, { a: "x", n: 9 }, { a: 1, n: "x" }, {}],
    ],
    [
      "a refinement",
      () =>
        z.object({
          a: z.string().refine((value) => value.length > 2, {
            error: (issue) => `got ${String((issue.input as string).length)}`,
          }),
        }),
      [{ a: "abc" }, { a: "x" }, { a: 1 }],
    ],
    [
      "an array and its elements",
      () =>
        z.object({
          xs: z
            .array(z.string({ error: dynamic }))
            .min(1, { error: (issue) => `need ${String(issue.minimum)}` }),
        }),
      [{ xs: ["a"] }, { xs: [] }, { xs: [1, "a", null] }, { xs: "no" }, {}],
    ],
    [
      "union options",
      () => z.union([z.string({ error: dynamic }), z.number({ error: dynamic })]),
      ["a", 1, true, undefined, null],
    ],
    [
      "discriminated union options",
      () =>
        z.discriminatedUnion("t", [
          z.object({ t: z.literal("a"), v: z.string({ error: dynamic }) }),
          z.object({ t: z.literal("b"), v: z.number({ error: dynamic }) }),
        ]),
      [{ t: "a", v: "x" }, { t: "b", v: 1 }, { t: "a", v: 1 }, { t: "b" }, { t: "c" }, 1],
    ],
    [
      "nested containers",
      () =>
        z.object({
          o: z.object({ p: z.string({ error: dynamic }) }, { error: dynamic }),
          k: z.enum(["a", "b"], { error: dynamic }),
        }),
      [{ o: { p: "x" }, k: "a" }, { o: {}, k: "z" }, { o: null, k: "a" }, {}],
    ],
    [
      "under optional, nullable and default",
      () =>
        z.object({
          a: z.string({ error: dynamic }).optional(),
          b: z.string({ error: dynamic }).nullable(),
          c: z.string({ error: dynamic }).default("d"),
        }),
      [{ b: null }, { a: "x", b: "y", c: "z" }, { a: 1, b: 2, c: 3 }, { a: undefined }, {}],
    ],
    [
      "a strict object, by reference",
      () => z.strictObject({ a: z.string({ error: dynamic }) }),
      [{ a: "x" }, { a: 1 }, { a: "x", extra: 1 }, {}],
    ],
    [
      "a loose object and a record, which hand their input back",
      () =>
        z.object({
          l: z.looseObject({ a: z.string() }, { error: dynamic }),
          r: z.record(z.string(), z.number({ error: dynamic })),
        }),
      [
        { l: { a: "x", more: 1 }, r: { k: 1 } },
        { l: 1, r: { k: "x" } },
        { l: JSON.parse('{"a":"x","__proto__":{"p":1}}'), r: {} },
        {},
      ],
    ],
    [
      "tuple items and set elements",
      () =>
        z.object({
          t: z.tuple([z.string({ error: dynamic }), z.number()]),
          s: z.set(z.string({ error: dynamic })).min(1, { error: dynamic }),
        }),
      [
        { t: ["a", 1], s: new Set(["x"]) },
        { t: [1, "a"], s: new Set() },
        { t: [], s: new Set([1]) },
      ],
    ],
    [
      "formats",
      () => z.object({ e: z.email({ error: dynamic }), u: z.uuid({ error: dynamic }) }),
      [
        { e: "a@b.co", u: "f47ac10b-58cc-4372-a567-0e02b2c3d479" },
        { e: "nope", u: "nope" },
        { e: 1 },
      ],
    ],
    [
      "a rewriting node",
      () => z.object({ a: z.string({ error: dynamic }).trim().min(2, { error: dynamic }) }),
      [{ a: "  ab  " }, { a: " a " }, { a: 1 }],
    ],
    [
      "a readonly primitive",
      () => z.object({ a: z.string({ error: dynamic }).readonly() }),
      [{ a: "x" }, { a: 1 }, {}],
    ],
  ];

  for (const [label, make, inputs] of POSITIONS) {
    it(`matches zod with the map on ${label}`, () => {
      expectParity(make(), inputs);
      expectLeanParity(make(), inputs);
    });
  }
});
