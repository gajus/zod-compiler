import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { jit } from "#src/jit.js";

/**
 * End-to-end behaviour of the methods `__zcMkv` installs on a schema whose
 * `safeParse` runs the single-pass build (a stripping `z.object()`):
 *
 *   - `.is()` is the acceptance-mode fast predicate, total even when a
 *     `.default()` substitutes a value the by-reference form would refuse;
 *   - `parse()`, `parseAsync()` and `~standard.validate` hand back the built
 *     (stripped, defaulted) value and zod's own issues on failure.
 *
 * `jit()` runs the same generateIIFE + `__zcMkv` the build plugin emits.
 */
const plain = z.object({
  page: z.number().int().default(1),
  q: z.string(),
  tags: z.array(z.string().default("t")).default([]),
});
const compiled = jit(plain.clone(), { eager: true });

const inputs: unknown[] = [
  { q: "x" },
  { q: "x", page: undefined },
  { q: "x", page: 2 },
  { q: "x", page: 2.5 },
  { q: "x", page: "2" },
  { q: "x", tags: ["a", undefined] },
  { q: "x", tags: [1] },
  { page: 1 },
  { q: "x", extra: 1 },
  {},
  null,
  "q",
];

describe("build-path schema: .is()", () => {
  it("matches safeParse().success for every input, defaults included", () => {
    for (const input of inputs) {
      expect(compiled.is(input), JSON.stringify(input)).toBe(plain.safeParse(input).success);
    }
  });

  it("holds for a defaulted root and a default under optional", () => {
    const root = z.object({ a: z.string() }).default({ a: "d" });
    const rootCompiled = jit(root.clone(), { eager: true });
    for (const input of [undefined, { a: "x" }, { a: 1 }, null]) {
      expect(rootCompiled.is(input), JSON.stringify(input)).toBe(root.safeParse(input).success);
    }
    const optional = z.object({ a: z.string().default("d").optional(), b: z.boolean() });
    const optionalCompiled = jit(optional.clone(), { eager: true });
    for (const input of [{ b: true }, { a: undefined, b: true }, { a: 1, b: true }, { a: "x" }]) {
      expect(optionalCompiled.is(input), JSON.stringify(input)).toBe(
        optional.safeParse(input).success,
      );
    }
  });
});

describe("build-path schema: parse(), parseAsync() and ~standard", () => {
  it("parse() returns the stripped, defaulted value and throws zod's error", () => {
    expect(compiled.parse({ q: "x", extra: 1 })).toStrictEqual({ page: 1, q: "x", tags: [] });
    expect(compiled.parse({ q: "x", page: 3, tags: ["a", undefined] })).toStrictEqual({
      page: 3,
      q: "x",
      tags: ["a", "t"],
    });
    let thrown: unknown;
    try {
      compiled.parse({ q: 1, page: "2" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(z.ZodError);
    expect((thrown as z.ZodError).issues).toStrictEqual(
      plain.safeParse({ q: 1, page: "2" }).error?.issues,
    );
  });

  it("parseAsync() resolves the built value and rejects with zod's error", async () => {
    await expect(compiled.parseAsync({ q: "x", extra: 1 })).resolves.toStrictEqual({
      page: 1,
      q: "x",
      tags: [],
    });
    await expect(compiled.parseAsync({ q: 1 })).rejects.toBeInstanceOf(z.ZodError);
  });

  it("~standard.validate hands back the built value, or zod's issues", () => {
    const validate = compiled["~standard"].validate;
    expect(validate({ q: "x", extra: 1 })).toStrictEqual({ value: { page: 1, q: "x", tags: [] } });
    const failed = validate({ q: 1 }) as { issues: unknown };
    expect(failed.issues).toStrictEqual(plain.safeParse({ q: 1 }).error?.issues);
  });

  it("agrees with safeParse() on every input", () => {
    for (const input of inputs) {
      const expected = plain.safeParse(input);
      if (expected.success) {
        expect(compiled.parse(input), JSON.stringify(input)).toStrictEqual(expected.data);
      } else {
        expect(() => compiled.parse(input), JSON.stringify(input)).toThrow(z.ZodError);
      }
    }
  });
});
