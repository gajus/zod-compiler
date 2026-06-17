/**
 * Regression for the user-reported SerializableValue schema: a recursive z.lazy
 * whose union contains z.unknown().refine(...).pipe(z.record(...)) plus an
 * array, with self-references inside both the pipe's record value and the
 * array. Asserts the compiler (a) compiles without crashing, (b) matches Zod on
 * accept/reject AND parsed data, and (c) matches Zod on full issue output —
 * including the pipe-as-union-option abort case (zod's handlePipeResult sets
 * payload.aborted when `in` fails, so the union surfaces invalid_union rather
 * than the inner custom refine message).
 */
import { describe, expect, it } from "vitest";
import { ZodRealError, z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { FAIL_CLASS_DECL, FIN_DECL, FIN_DEFERRED_DECL } from "#src/core/iife.js";

const localizedFin = new Function(
  "__zcMsg",
  "__zcZodError",
  `${FAIL_CLASS_DECL}${FIN_DECL}; return __zcFin;`,
)(z.config().localeError, ZodRealError);

function compileLikeProduction(schema: unknown): {
  fn: (input: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown[] } };
  refCount: number;
} {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const generated = generateValidator(ir, "rec", { refCount: refEntries.length });
  const factory = new Function(
    "__zcMsg",
    "__zcZodError",
    "__zcFin",
    "__rf",
    `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\n${generated.code}\nreturn ${generated.functionDef};`,
  );
  const fn = factory(
    z.config().localeError,
    ZodRealError,
    localizedFin,
    refEntries.map((e) => e.schema),
  );
  return { fn, refCount: refEntries.length };
}

const isPlainObject = (val: unknown): boolean => {
  if (typeof val !== "object" || val === null) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
};

const LiteralZodSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

type SerializableValue =
  | Literal
  | readonly SerializableValue[]
  | { readonly [key: string]: SerializableValue };
type Literal = boolean | null | number | string;

const SerializableValueZodSchema: z.ZodType<SerializableValue> = z.lazy(() =>
  z.union([
    z
      .unknown()
      .refine((val) => isPlainObject(val), { error: "Must be a plain object" })
      .pipe(z.record(z.string(), SerializableValueZodSchema)),
    LiteralZodSchema,
    z.array(SerializableValueZodSchema),
  ]),
);

const norm = (issues: { path: unknown; code?: unknown; message?: unknown }[]) =>
  issues.map((i) => ({ path: i.path, code: i.code, message: i.message }));

const label = (input: unknown): string => {
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
};

const samples: unknown[] = [
  "hello",
  "",
  42,
  0,
  -3.14,
  true,
  false,
  null,
  [],
  [1, 2, 3],
  ["a", true, null, 5],
  [[1], [2, [3, [4]]]],
  {},
  { a: 1, b: "two", c: false, d: null },
  { nested: { deep: { deeper: [1, "x", { k: true }] } } },
  { list: [{ x: 1 }, { y: [2, 3] }] },
  { a: [1, { b: [2, { c: null }] }] },
  undefined,
  () => {},
  Symbol("s"),
  123n,
  new Date(),
  { a: undefined },
  { a: () => {} },
  [undefined],
  [() => {}],
  { a: { b: Symbol("x") } },
  [1, [2, [undefined]]],
  new (class Foo {
    x = 1;
  })(),
  { a: new (class Bar {})() },
  [new (class Baz {})()],
  Number.NaN,
  Number.POSITIVE_INFINITY,
  // nested non-plain object inside an otherwise valid record/array
  { k0: [], k1: { bad: new Date() } },
  [{ a: 1 }, new Date()],
];

describe("SerializableValue (recursive lazy + refine.pipe(record) union)", () => {
  it("compiles with exactly one Zod fallback (the un-inlinable refine)", () => {
    const { refCount } = compileLikeProduction(SerializableValueZodSchema);
    expect(refCount).toBe(1);
  });

  it("matches Zod on accept/reject, parsed data, and full issue output", () => {
    const { fn } = compileLikeProduction(SerializableValueZodSchema);
    for (const input of samples) {
      const got = fn(input);
      const want = SerializableValueZodSchema.safeParse(input);
      expect(got.success, `accept/reject :: ${label(input)}`).toBe(want.success);
      if (want.success) {
        expect(JSON.stringify(got.data), `data :: ${label(input)}`).toBe(JSON.stringify(want.data));
      } else {
        expect(norm(got.error?.issues as never[]), `issues :: ${label(input)}`).toEqual(
          norm(want.error.issues as never[]),
        );
      }
    }
  });
});

// ─── The same abort semantics through a pass-through wrapper ──────────────────

describe("pipe-as-union-option abort through optional/nullable", () => {
  const Plain = z
    .unknown()
    .refine((v) => isPlainObject(v), { error: "Must be a plain object" })
    .pipe(z.record(z.string(), z.number()));

  it("union([pipe.optional(), number]) matches Zod issue output for a Date", () => {
    const schema = z.union([Plain.optional(), z.number()]);
    const { fn } = compileLikeProduction(schema);
    for (const input of [new Date(), "str", {}, { a: 1 }, { a: "x" }, 5, undefined]) {
      const got = fn(input);
      const want = schema.safeParse(input);
      expect(got.success, `accept :: ${label(input)}`).toBe(want.success);
      if (!want.success) {
        expect(norm(got.error?.issues as never[]), `issues :: ${label(input)}`).toEqual(
          norm(want.error.issues as never[]),
        );
      }
    }
  });
});

// ─── Standalone pipe short-circuit (zod's handlePipeResult) ───────────────────

describe("standalone pipe surfaces only `in` issues when `in` fails", () => {
  it("z.string().pipe(z.string().min(3)) matches Zod (no duplicate out-issue)", () => {
    const schema = z.string().pipe(z.string().min(3));
    const { fn } = compileLikeProduction(schema);
    // 42 fails `in` (not a string): zod short-circuits, so only ONE invalid_type
    // issue — not a second from re-running `out` on the same bad value.
    for (const input of [42, "ok!", "no", "", true, null]) {
      const got = fn(input);
      const want = schema.safeParse(input);
      expect(got.success, `accept :: ${label(input)}`).toBe(want.success);
      if (!want.success) {
        expect(norm(got.error?.issues as never[]), `issues :: ${label(input)}`).toEqual(
          norm(want.error.issues as never[]),
        );
      }
    }
  });
});
