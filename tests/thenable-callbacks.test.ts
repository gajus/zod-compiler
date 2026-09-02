import { describe, expect, it } from "vite-plus/test";
import { core, z } from "zod";
import { jit } from "#src/jit.js";

/**
 * A user callback that returns a Promise from a plain (non-async) function
 * cannot be told apart at extraction time — only `async` functions are
 * detected and delegated — so the compiled code tests the RETURNED value, as
 * zod does: a `.refine()` predicate, a `.transform()` or a `z.preprocess()`
 * that hands back a Promise makes the synchronous parse throw
 * `$ZodAsyncError`. Before, a predicate's Promise was simply truthy, so the
 * compiled validator ACCEPTED input zod refuses to decide on, and a transform's
 * Promise became the output value.
 *
 * `.catch()`, `.default()` and `.overwrite()` are not guarded, matching zod,
 * which substitutes whatever they return.
 */
const later = <T>(v: T) => Promise.resolve(v);
const isAsyncError = (e: unknown) => e instanceof core.$ZodAsyncError;

const throwing: [string, () => z.ZodType, unknown][] = [
  ["refine predicate", () => z.string().refine(() => later(false)), "x"],
  [
    "refine predicate in object (fast path)",
    () => z.object({ a: z.string().refine(() => later(true)) }),
    { a: "x" },
  ],
  [
    "refine on object (build path)",
    () => z.object({ a: z.string() }).refine(() => later(true)),
    { a: "x" },
  ],
  ["refine on array", () => z.array(z.string()).refine(() => later(true)), ["x"]],
  ["refine on number", () => z.number().refine(() => later(true)), 1],
  ["refine with abort", () => z.string().refine(() => later(false), { abort: true }), "x"],
  ["custom predicate", () => z.custom(() => later(true)), "x"],
  ["transform", () => z.string().transform(() => later(1)), "x"],
  ["transform in array", () => z.array(z.string().transform(() => later(1))), ["x"]],
  ["preprocess", () => z.preprocess(() => later("x"), z.string()), "x"],
  [
    "preprocess in object (build path)",
    () => z.object({ a: z.preprocess(() => later("x"), z.string()) }),
    { a: 1 },
  ],
  ["preprocess in array", () => z.array(z.preprocess(() => later("x"), z.string())), [1]],
  ["superRefine", () => z.string().superRefine(() => later(undefined)), "x"],
];

describe("callbacks that return a Promise", () => {
  for (const [name, mk, input] of throwing) {
    it(`${name}: sync parse throws $ZodAsyncError, like zod`, () => {
      const compiled = jit(mk(), { eager: true });
      expect(() => mk().safeParse(input)).toThrow();
      expect(() => compiled.safeParse(input)).toThrow(core.$ZodAsyncError);
      expect(() => compiled.parse(input)).toThrow(core.$ZodAsyncError);
    });

    it(`${name}: the async entry points resolve as zod's do`, async () => {
      // The compiled wrapper catches the sync throw and re-runs zod's async
      // pipeline, so an async-capable caller gets zod's own answer.
      const compiled = jit(mk(), { eager: true });
      const expected = await mk().safeParseAsync(input);
      const actual = await compiled.safeParseAsync(input);
      expect(actual.success).toBe(expected.success);
      if (!expected.success && !actual.success) {
        expect(actual.error.issues).toEqual(expected.error.issues);
      } else if (expected.success && actual.success) {
        expect(actual.data).toEqual(expected.data);
      }
    });
  }

  it("a non-Promise thenable is a plain value, as it is to zod", () => {
    // oxlint-disable-next-line unicorn/no-thenable -- the thenable IS the subject under test
    const thenable = { then() {} };
    const mk = () => z.preprocess(() => thenable, z.any());
    const compiled = jit(mk(), { eager: true });
    expect(compiled.safeParse("x")).toEqual(mk().safeParse("x"));
  });

  it("catch, default and overwrite substitute the Promise itself, like zod", () => {
    const factories: (() => z.ZodType)[] = [
      () => z.string().catch(() => later("c")),
      () => z.string().default(() => later("d")),
      () => z.string().overwrite(() => later("o") as unknown as string),
    ];
    const inputs = [1, undefined, "x"];
    factories.forEach((mk, i) => {
      const compiled = jit(mk(), { eager: true });
      const expected = mk().safeParse(inputs[i]);
      const actual = compiled.safeParse(inputs[i]);
      expect(actual.success).toBe(true);
      expect(expected.success).toBe(true);
      if (actual.success && expected.success) {
        expect(actual.data).toBeInstanceOf(Promise);
        expect(expected.data).toBeInstanceOf(Promise);
      }
    });
  });

  it("a refine inside a union option throws when that option is probed", () => {
    // zod's runChecks throws the moment a check returns a Promise under a sync
    // parse — it does not wait to see whether another option matches — and the
    // compiled probe throws at the same point. One documented difference stays:
    // the compiled fast union probes cheap options first, so a sibling that
    // matches outright can be reached before the Promise-returning option zod
    // would have evaluated first (option order is otherwise unobservable).
    const mk = () => z.union([z.string().refine(() => later(true)), z.number()]);
    const compiled = jit(mk(), { eager: true });
    expect(() => mk().safeParse("x")).toThrow(core.$ZodAsyncError);
    expect(() => compiled.safeParse("x")).toThrow(core.$ZodAsyncError);
    expect(compiled.safeParse(1)).toEqual(mk().safeParse(1));
  });

  it("is() throws too: there is no synchronous verdict to give", () => {
    const compiled = jit(z.object({ a: z.string().refine(() => later(true)) }), { eager: true });
    expect(() => compiled.is({ a: "x" })).toThrow(core.$ZodAsyncError);
  });

  it("the throw is eager, not deferred to the .error read", () => {
    // A fast-eligible schema defers its slow walk until `.error` is read; the
    // Promise must not hide in that deferral and surface as a failed result.
    const compiled = jit(
      z.string().refine(() => later(false)),
      { eager: true },
    );
    let threw = false;
    try {
      compiled.safeParse("x");
    } catch (e) {
      threw = isAsyncError(e);
    }
    expect(threw).toBe(true);
  });

  it("ordinary predicates and transforms are untouched", () => {
    const mk = () =>
      z.object({
        a: z.string().refine((s) => s.length > 0),
        b: z.string().transform((s) => s.length),
        c: z.preprocess((v) => String(v), z.string()),
      });
    const compiled = jit(mk(), { eager: true });
    for (const input of [
      { a: "x", b: "ab", c: 1 },
      { a: "", b: "ab", c: 1 },
      { a: 1, b: 2, c: 3 },
    ]) {
      const expected = mk().safeParse(input);
      const actual = compiled.safeParse(input);
      expect(actual.success).toBe(expected.success);
      if (expected.success && actual.success) expect(actual.data).toEqual(expected.data);
      if (!expected.success && !actual.success)
        expect(actual.error.issues).toEqual(expected.error.issues);
    }
  });
});
