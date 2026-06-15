/**
 * Known divergences from Zod — intentional tradeoffs the compiler does NOT
 * close, all rooted in its zero-allocation design: a mutation-free schema
 * returns the validated input BY REFERENCE on success (see generateValidator's
 * `return{success:true,data:input}` path) and iterates objects/records with an
 * allocation-free `for-in`. Matching Zod here would mean allocating a fresh
 * output object (or a Reflect.ownKeys array) on every successful parse — the
 * exact cost the compiler exists to avoid.
 *
 * Each gap is pinned with an explicit dual assertion (Zod's behavior AND the
 * compiler's) so the suite stays green and documents reality. If a future
 * change closes a gap, the compiler-side assertion breaks — a prompt to delete
 * the pin and promote it to a parity regression in edge-cases.test.ts.
 *
 * NOTE: these are distinct from bugs that were found and fixed (collection
 * element-vs-size issue ordering, duplicate discriminator throw) — those now
 * live as parity regressions in edge-cases.test.ts.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

/**
 * 1. UNKNOWN-KEY STRIPPING.
 *
 * Zod's default `z.object()` strips unknown keys (only `z.looseObject()` keeps
 * them, `z.strictObject()` errors). The compiler returns the validated input by
 * reference whenever no property mutates (src/core/codegen/schemas/object.ts
 * clones only when `Object.values(properties).some(hasMutation)`), so unknown
 * keys — including `__proto__`, symbol keys, and inherited enumerables — pass
 * straight through. Observable, security-relevant (overposting), and systemic:
 * it affects every plain object in every position. Closing it means rebuilding
 * the object from only the known keys on every successful parse.
 */
describe("known divergence — z.object() does not strip unknown keys", () => {
  it.fails("top-level object strips extra string keys", () => {
    expectParity(z.object({ a: z.string() }), [{ a: "x", b: 1, c: "extra" }]);
  });
  it.fails("nested object strips extra keys at depth", () => {
    expectParity(z.object({ outer: z.object({ a: z.string() }) }), [
      { outer: { a: "x", b: 2 }, extra: 9 },
    ]);
  });
  it.fails("object inside array element strips extra keys", () => {
    expectParity(z.array(z.object({ a: z.string() })), [[{ a: "x", b: 1 }]]);
  });
  it.fails(".pick() result strips extra keys", () => {
    expectParity(z.object({ a: z.string(), b: z.number() }).pick({ a: true }), [
      { a: "x", b: 1, c: 9 },
    ]);
  });
  it.fails(".partial() result strips extra keys", () => {
    expectParity(z.object({ a: z.string() }).partial(), [{ a: "x", z: 9 }]);
  });
  it.fails("intersection of objects strips keys outside both shapes", () => {
    expectParity(z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })), [
      { a: "x", b: 1, c: 9 },
    ]);
  });
  it.fails("discriminated-union option strips extra keys", () => {
    expectParity(
      z.discriminatedUnion("t", [
        z.object({ t: z.literal("a"), x: z.string() }),
        z.object({ t: z.literal("b"), y: z.number() }),
      ]),
      [{ t: "a", x: "s", extra: 9 }],
    );
  });

  // Sharpest, dependency-free statement of the gap: the compiled output is the
  // input object itself (same reference), so unknown keys are retained.
  it("compiled returns the input by reference (documents the mechanism)", () => {
    const schema = z.object({ a: z.string() });
    const input = { a: "x", b: 1 };
    const compiled = compileLikeProduction(schema, "stripDoc");
    const r = compiled(input) as { success: true; data: Record<string, unknown> };
    expect(z.object({ a: z.string() }).parse(input)).toEqual({ a: "x" }); // Zod strips
    expect(r.data).toBe(input); // compiler passes the input through unchanged
    expect(Object.keys(r.data)).toEqual(["a", "b"]); // including the unknown key
  });

  // A `__proto__` own ENUMERABLE data property (as produced by JSON.parse, which
  // never sets the prototype) is just another unknown key: Zod strips it, the
  // compiler retains it by reference. Pinned explicitly because the retained key
  // is named `__proto__` — but this is NOT prototype pollution: the compiler only
  // returns the input untouched, it never assigns `obj.__proto__ = …`, so the
  // result's prototype stays Object.prototype and no global is mutated.
  it("__proto__ own-key is retained by reference but does not pollute the prototype", () => {
    const schema = z.object({ a: z.string() });
    const input = JSON.parse('{"a":"x","__proto__":{"polluted":true}}') as Record<string, unknown>;
    const compiled = compileLikeProduction(schema, "protoDoc");
    const r = compiled(input) as { success: true; data: Record<string, unknown> };
    expect(z.object({ a: z.string() }).parse(input)).toEqual({ a: "x" }); // Zod strips __proto__
    expect(r.data).toBe(input); // compiler retains it (same reference)
    expect(Object.prototype.hasOwnProperty.call(r.data, "__proto__")).toBe(true);
    // No pollution: the prototype is untouched and no stray global leaked.
    expect(Object.getPrototypeOf(r.data)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

/**
 * 2. ARRAY OUTPUT IDENTITY.
 *
 * Zod builds a fresh array from the validated elements (dense, no extra own
 * properties). The compiler returns the input array by reference when the
 * element type doesn't mutate (src/core/codegen/schemas/array.ts), so a sparse
 * array keeps its holes and any non-index own properties survive.
 */
describe("known divergence — array output keeps sparseness / extra properties", () => {
  it("compiled array output is the input by reference", () => {
    const schema = z.array(z.string());
    const input = ["a", "b"] as string[] & { meta?: number };
    input.meta = 7;
    const compiled = compileLikeProduction(schema, "arrId");
    const r = compiled(input) as { success: true; data: string[] & { meta?: number } };
    const zr = schema.safeParse(input) as { success: true; data: string[] & { meta?: number } };
    expect(zr.data.meta).toBeUndefined(); // Zod drops the non-index property
    expect(r.data.meta).toBe(7); // compiler retains it (same reference)
    expect(r.data).toBe(input);
  });
});

/**
 * 3. RECORD KEY ITERATION — for-in vs Reflect.ownKeys.
 *
 * The compiler iterates records with an allocation-free `for-in` (own
 * ENUMERABLE STRING keys), while Zod walks `Reflect.ownKeys` — every own key,
 * including non-enumerable string keys AND symbol keys. So the compiler ignores
 * keys Zod validates (and, for string-shaped key schemas, rejects): symbol keys
 * are silently accepted, and a non-enumerable string key is skipped entirely.
 * Closing this means replacing for-in with a Reflect.ownKeys keys-array
 * allocation on every record parse — the cost for-in deliberately avoids (the
 * code notes for-in is 2.9–5.8x faster than the Object.keys form).
 */
describe("known divergence — record iterates own enumerable string keys only", () => {
  it("symbol key is rejected by Zod but ignored by the compiler", () => {
    const schema = z.record(z.string(), z.number());
    const sym = Symbol("s");
    const input = { a: 1, [sym]: 2 } as Record<string | symbol, unknown>;
    const compiled = compileLikeProduction(schema, "symKey");
    expect(schema.safeParse(input).success).toBe(false); // Zod validates the symbol key
    expect((compiled(input) as { success: boolean }).success).toBe(true); // compiler ignores it
  });
  it("non-enumerable string key is validated by Zod but ignored by the compiler", () => {
    const schema = z.record(z.string(), z.number());
    const input = { a: 1 } as Record<string, unknown>;
    Object.defineProperty(input, "hidden", { value: "not-a-number", enumerable: false });
    const compiled = compileLikeProduction(schema, "nonEnum");
    expect(schema.safeParse(input).success).toBe(false); // Zod sees `hidden` and rejects its value
    expect((compiled(input) as { success: boolean }).success).toBe(true); // for-in never visits it
  });
});
