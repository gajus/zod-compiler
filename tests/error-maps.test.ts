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
import { resolveCheckMessage } from "#src/core/extract/checks.js";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import { compileLikeProduction } from "./parity-harness.js";

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
