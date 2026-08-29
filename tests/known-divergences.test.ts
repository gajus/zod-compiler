/**
 * Known divergences from Zod — intentional tradeoffs the compiler does NOT
 * close, all rooted in its zero-allocation design: a schema that reshapes
 * nothing returns the validated input BY REFERENCE on success (see
 * generateValidator's `return{success:true,data:input}` path) and iterates
 * objects/records with an allocation-free `for-in`. Matching Zod here would
 * mean allocating a fresh output on every successful parse — the exact cost the
 * compiler exists to avoid.
 *
 * `z.object()` is NOT among these: it strips unknown keys like Zod, rebuilding
 * its output in one validate-and-build pass (see build-path.ts). What remains
 * below are containers Zod rebuilds and the compiler still passes through.
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
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { compileLikeProduction } from "./parity-harness.js";

/**
 * 1. ARRAY OUTPUT IDENTITY.
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
 * 2. RECORD KEY ITERATION — for-in vs Reflect.ownKeys.
 *
 * The compiler iterates records with an allocation-free `for-in` (own
 * ENUMERABLE STRING keys), while Zod walks `Reflect.ownKeys` filtered to the
 * enumerable ones — so it also sees an own enumerable SYMBOL key, which a
 * string-shaped key schema then rejects. The compiler silently accepts it.
 * Closing this means replacing for-in with a Reflect.ownKeys keys-array
 * allocation on every record parse — the cost for-in deliberately avoids (the
 * code notes for-in is 2.9–5.8x faster than the Object.keys form). A
 * non-enumerable key, string or symbol, is skipped by both sides.
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
  it("a non-enumerable key is skipped by both", () => {
    const schema = z.record(z.string(), z.number());
    const input = { a: 1 } as Record<string | symbol, unknown>;
    Object.defineProperty(input, "hidden", { value: "not-a-number", enumerable: false });
    Object.defineProperty(input, Symbol("h"), { value: "not-a-number", enumerable: false });
    const compiled = compileLikeProduction(schema, "nonEnum");
    expect(schema.safeParse(input).success).toBe(true);
    expect((compiled(input) as { success: boolean }).success).toBe(true);
  });
});

/**
 * 3. RECORD / LOOSE-OBJECT OUTPUT IDENTITY.
 *
 * Zod's record and catchall paths parse into a FRESH `{}` and copy the keys they
 * accept onto it. Three things follow that the compiler's by-reference output
 * does not reproduce, none of which changes the verdict:
 *
 *   - the output is always an ordinary plain object, so a null-prototype input
 *     (or one inheriting from another object) comes back with `Object.prototype`;
 *   - an own `__proto__` key is dropped, because zod's record walk skips it and
 *     never copies it across (the compiler skips VALIDATING it too — that part
 *     is parity, and is pinned in uncovered-api-parity.test.ts — but the key
 *     rides along in the input it hands back);
 *   - a symbol key survives, where zod's copy loop (`for … in`) never sees one.
 *
 * Closing any of them means allocating a fresh object on every successful record
 * parse, which is the cost the by-reference design exists to avoid.
 */
describe("known divergence — record output is the input, not a fresh plain object", () => {
  const schema = z.record(z.string(), z.string());

  it("a null-prototype input keeps its prototype", () => {
    const input = Object.assign(Object.create(null) as Record<string, string>, { a: "x" });
    const compiled = compileLikeProduction(schema, "recNullProto");
    const zodData = schema.safeParse(input).data as object;
    const ourData = (compiled(input) as { data: object }).data;
    expect(Object.getPrototypeOf(zodData)).toBe(Object.prototype); // zod rebuilt
    expect(Object.getPrototypeOf(ourData)).toBeNull(); // compiler passed through
    expect(ourData).toBe(input);
  });

  it("an own `__proto__` key rides along in the output", () => {
    const input = JSON.parse('{"a":"x","__proto__":{"polluted":true}}') as Record<string, string>;
    const compiled = compileLikeProduction(schema, "recProtoKey");
    const zodData = schema.safeParse(input).data as object;
    const ourData = (compiled(input) as { data: object }).data;
    expect(Object.hasOwn(zodData, "__proto__")).toBe(false); // zod dropped it
    expect(Object.hasOwn(ourData, "__proto__")).toBe(true); // compiler kept it
    // Neither side POLLUTES: the key stays an own data property on both.
    expect(Object.getPrototypeOf(ourData)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("a loose object passes its input through, symbol keys and all", () => {
    const key = Symbol("s");
    const loose = z.looseObject({ a: z.string() });
    const input = { a: "x", [key]: 1 };
    const compiled = compileLikeProduction(loose, "looseIdentity");
    const zodData = loose.safeParse(input).data as object;
    const ourData = (compiled(input) as { data: object }).data;
    expect(Object.getOwnPropertySymbols(zodData)).toStrictEqual([]); // zod rebuilt
    expect(Object.getOwnPropertySymbols(ourData)).toStrictEqual([key]);
    expect(ourData).toBe(input);
  });
});

describe("known divergence — a catchall validates inherited keys but cannot re-home them", () => {
  // zod's handleCatchall iterates the input with a BARE for-in, so a key found
  // on the prototype is validated — the compiler matches that exactly. What it
  // cannot match is the output: zod parses into a fresh `{}` and writes every
  // for-in key onto it, turning an inherited key into an OWN key, while
  // compiled output is the input by reference and leaves it on the prototype.
  const schema = z.object({ a: z.number() }).catchall(z.string());
  const withInherited = () => Object.assign(Object.create({ inh: "yes" }), { a: 1 });

  it("agrees on the verdict, including rejecting a bad inherited value", () => {
    const compiled = compileLikeProduction(schema, "caInhVerdict");
    const bad = Object.assign(Object.create({ inh: 99 }), { a: 1 });
    expect(schema.safeParse(withInherited()).success).toBe(true);
    expect((compiled(withInherited()) as { success: boolean }).success).toBe(true);
    expect(schema.safeParse(bad).success).toBe(false);
    expect((compiled(bad) as { success: boolean }).success).toBe(false);
  });

  it("zod promotes the inherited key to an own key; the compiler does not", () => {
    const compiled = compileLikeProduction(schema, "caInhOutput");
    const zodData = schema.safeParse(withInherited()).data as Record<string, unknown>;
    const ourData = (compiled(withInherited()) as { data: Record<string, unknown> }).data;
    expect(Object.hasOwn(zodData, "inh")).toBe(true);
    expect(Object.hasOwn(ourData, "inh")).toBe(false);
    // Still readable through the chain, so property access agrees.
    expect(ourData["inh"]).toBe("yes");
  });
});

/**
 * `z.catch()`'s RAW `ctx.issues` VIEW.
 *
 * zod's $ZodCatch hands the catch callback a ctx with two different views of
 * the same failure: `ctx.error.issues`, finalized by `util.finalizeIssue`
 * (message filled in, `path` defaulted, `input` deleted), and `ctx.issues`,
 * which is the RAW `payload.issues` array straight off the inner parse — no
 * `message`, no `path`, but WITH `input`, with `inst`, the $ZodType instance
 * that raised the issue, and with `schema`, the instance that owns it (the
 * same object for an issue a schema raised itself; the enclosing schema for one
 * its check raised). They are distinct arrays holding distinct objects.
 *
 * The compiler produces ONE finalized array and passes it as both fields, so
 * `ctx.issues` gets the finalized shape rather than the raw one. `inst` and
 * `schema` are what make the raw view unreachable: they are live zod schema
 * objects for the failing node, and compiled code has no such object — a leaf
 * like the inner `z.string()` is erased into inline type tests at build time,
 * with no runtime value to name. Synthesizing a stand-in would be a lie an
 * error map could dereference (`iss.inst._zod.def`) and crash on, so the raw
 * view is left as the finalized one; the finalized view — the one zod's own
 * docs point at, and the only one carrying human-readable messages — matches
 * exactly.
 */
describe("known divergence — z.catch()'s raw ctx.issues view is the finalized one", () => {
  const seen = (sink: (ctx: { issues: unknown[]; error: { issues: unknown[] } }) => void) =>
    z.string().catch((ctx) => {
      sink(ctx as unknown as { issues: unknown[]; error: { issues: unknown[] } });
      return "fallback";
    });

  const capture = (
    run: (sink: (ctx: { issues: unknown[]; error: { issues: unknown[] } }) => void) => void,
  ) => {
    let captured: { issues: unknown[]; error: { issues: unknown[] } } | undefined;
    run((ctx) => {
      captured = ctx;
    });
    if (!captured) throw new Error("catch callback never ran");
    return captured;
  };

  it("zod's ctx.issues is the raw payload (input + inst + schema, no message/path)", () => {
    const ctx = capture((sink) => {
      seen(sink).safeParse(123);
    });
    expect(Object.keys(ctx.issues[0] as object).sort()).toStrictEqual([
      "code",
      "expected",
      "input",
      "inst",
      "schema",
    ]);
    // ...and it is a DIFFERENT array from the finalized one.
    expect(ctx.issues).not.toBe(ctx.error.issues);
    expect(Object.keys(ctx.error.issues[0] as object).sort()).toStrictEqual([
      "code",
      "expected",
      "message",
      "path",
    ]);
  });

  it("the compiler serves the finalized array for both views", () => {
    const ctx = capture((sink) => {
      compileLikeProduction(seen(sink), "catchRawView")(123);
    });
    expect(ctx.issues).toBe(ctx.error.issues);
    expect(Object.keys(ctx.issues[0] as object).sort()).toStrictEqual([
      "code",
      "expected",
      "message",
      "path",
    ]);
  });
});

/**
 * WHEN A FAILURE'S ERROR IS BUILT.
 *
 * zod builds the whole ZodError inside `safeParse` — locale messages included.
 * A compiled failure builds nothing there: the issue walk, the locale fill, the
 * `input` strip and the ZodError construction are all deferred into the cached
 * `.error` accessor (see FAIL_CLASS_DECL in src/core/iife.ts), so a rejected
 * parse whose `.error` is never read — `safeParse(x).success`, `.is(x)` — costs
 * only the fast check. That is the deferral the compiler exists to buy.
 *
 * It is unobservable except in one place: when building the MESSAGE itself
 * throws. `z.literal(Symbol())`'s locale runs the symbol through a template
 * string, which is a TypeError, so zod's safeParse throws while the compiled
 * safeParse returns a failure and throws only once `.error` is read. Closing it
 * means building every error eagerly — the exact cost the deferral removes, to
 * reproduce a zod defect (a schema zod cannot report on at all).
 *
 * `expectParity` reads `.error` on a compiled failure before comparing throws,
 * so the harness compares the same work on both sides rather than pretending
 * this gap does not exist.
 */
describe("known divergence — a compiled failure builds its error lazily", () => {
  const schema = z.literal(Symbol("s"));

  it("zod throws from safeParse; the compiler throws from .error", () => {
    expect(() => schema.safeParse("nope")).toThrow(TypeError);

    const compiled = compileLikeProduction(schema, "lazyErrThrow");
    const result = compiled("nope") as { success: boolean; error: unknown };
    expect(result.success).toBe(false); // safeParse itself survives
    expect(() => result.error).toThrow(TypeError); // ...the message build does not
  });
});

/**
 * 6. z.readonly() OVER A PRIMITIVE FREEZES A VALUE ITS INNER REJECTED.
 *
 * `$ZodReadonly` freezes `payload.value` after running its inner schema without
 * checking whether that schema produced issues (`handleReadonlyResult` only
 * spares a memoized revisit). When the inner is a primitive and the value is an object, the
 * payload still holds the caller's own object — so Zod freezes data it just
 * rejected. A plain `z.string()` does not.
 *
 * Freezing is a no-op on every value such a schema ACCEPTS (`Object.isFrozen("a")`
 * is already true), which is what lets the compiler drop the wrapper and keep
 * the enclosing object on the fast path. What it does not reproduce is the
 * freeze on the rejected path, and that has two observable shapes:
 *
 *   a. the caller's rejected input stays mutable (the parse verdict, data and
 *      issues are all identical);
 *   b. inside a union, where it reaches a SUCCESSFUL parse. Zod hands the same
 *      object to every option, so a failing readonly option freezes it and a
 *      later permissive option then returns that now-frozen object as `data`.
 *
 * (b) is the same class as divergences 1-3 above — Zod's output identity versus
 * the compiler's — and never changes the parsed VALUE, only whether it is
 * frozen. Closing either would mean a type test plus a freeze on every readonly
 * failure: hot-path cost on every schema to reproduce a Zod bug on rejected
 * data. If Zod ever makes the freeze conditional on success, delete this pin.
 */
describe("known divergence — readonly does not freeze a rejected value", () => {
  const schema = z.string().readonly();

  it("zod freezes the rejected object; the compiler leaves it alone", () => {
    const zodInput = {};
    expect(schema.safeParse(zodInput).success).toBe(false);
    expect(Object.isFrozen(zodInput)).toBe(true); // zod froze what it rejected

    const compiled = compileLikeProduction(schema, "roRejectFreeze");
    const aotInput = {};
    expect((compiled(aotInput) as { success: boolean }).success).toBe(false);
    expect(Object.isFrozen(aotInput)).toBe(false); // the compiler did not
  });

  it("also applies to a readonly OBJECT handed a non-object", () => {
    // Same cause, other end of the feature: the object schema rejects the array,
    // but zod's readonly freezes the payload value on the way past — and that
    // value is still the caller's array.
    const objectSchema = z.object({ name: z.string() }).readonly();
    const zodInput: unknown[] = [1, 2];
    expect(objectSchema.safeParse(zodInput).success).toBe(false);
    expect(Object.isFrozen(zodInput)).toBe(true);

    const compiled = compileLikeProduction(objectSchema, "roObjRejectFreeze");
    const aotInput: unknown[] = [1, 2];
    expect((compiled(aotInput) as { success: boolean }).success).toBe(false);
    expect(Object.isFrozen(aotInput)).toBe(false);
  });

  it("a union sibling can carry that freeze onto a successful parse", () => {
    // The readonly option REJECTS the object, but zod froze it on the way past,
    // and z.any() then succeeds with the very same reference.
    const union = z.union([z.string().readonly(), z.any()]);
    const compiled = compileLikeProduction(union, "roUnionFreeze");

    const zodResult = union.safeParse({ a: 1 }) as { success: boolean; data: unknown };
    const aotResult = compiled({ a: 1 }) as { success: boolean; data: unknown };

    expect(aotResult.success).toBe(zodResult.success); // both succeed
    expect(aotResult.data).toEqual(zodResult.data); // same value...
    expect(Object.isFrozen(zodResult.data)).toBe(true); // ...zod's is frozen
    expect(Object.isFrozen(aotResult.data)).toBe(false); // ...the compiler's is not
  });

  it("both agree on every value the schema accepts", () => {
    const compiled = compileLikeProduction(schema, "roAcceptParity");
    for (const input of ["a", ""]) {
      const zodResult = schema.safeParse(input);
      const aotResult = compiled(input) as { success: boolean; data?: unknown };
      expect(aotResult.success).toBe(zodResult.success);
      expect(aotResult.data).toBe(zodResult.data);
      expect(Object.isFrozen(aotResult.data)).toBe(Object.isFrozen(zodResult.data));
    }
  });
});
