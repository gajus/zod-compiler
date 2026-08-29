/**
 * Differential parity for Zod API surface the rest of the suite never reached.
 *
 * Everything here is a schema form Zod itself documents and parses fine, but
 * that no existing test exercised — so a divergence could ship green. Each case
 * pins both halves: `expectParity` compares accept/reject, output data and the
 * whole issue list against Zod, and `expectCompiled` proves the schema really
 * compiled (no `fallback` IR, no Zod-delegated refs) rather than silently
 * handing the work back to Zod, which would hide a divergence by construction.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import { stringBoolUsesInline } from "#src/core/codegen/schemas/string-bool.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import type { StringBoolIR } from "#src/core/types.js";
import type { ZodLikeSchema } from "./parity-harness.js";
import {
  compileLeanLikeProduction,
  compileLikeProduction,
  expectParity,
} from "./parity-harness.js";

/** Extraction produced a real compiled validator, not a delegation to Zod. */
function expectCompiled(schema: unknown): void {
  const refs: RefEntry[] = [];
  const ir = extractSchema(schema, refs);
  expect(ir.type, "root IR should not be a Zod fallback").not.toBe("fallback");
  expect(refs, "schema should compile with no Zod-delegated fallbacks").toHaveLength(0);
}

// ─── Getter-declared recursion ──────────────────────────────────────────────
// Zod v4 documents shape getters — `get subcategories() { return z.array(Cat) }`
// — as the way to declare a recursive schema, and unlike `z.lazy()` the cycle
// carries no marker node: the back-edge is an ordinary shape entry. Detection
// therefore has to come from `dispatch` re-entering a schema still on the
// `visiting` stack; before that existed, extraction walked the same shape until
// the process died with "Maximum call stack size exceeded".

describe("getter-declared recursion", () => {
  it("self-referencing object (root cycle)", () => {
    const Category = z.object({
      name: z.string(),
      get subcategories() {
        return z.array(Category);
      },
    });
    expectCompiled(Category);
    expectParity(
      Category,
      [
        { name: "root", subcategories: [] },
        { name: "root", subcategories: [{ name: "kid", subcategories: [] }] },
        {
          name: "root",
          subcategories: [
            { name: "kid", subcategories: [{ name: "grandkid", subcategories: [] }] },
          ],
        },
        { name: "root", subcategories: [{ name: 7, subcategories: [] }] },
        { name: "root", subcategories: [{ name: "kid", subcategories: [{ name: "gk" }] }] },
        { name: "root" },
        { name: "root", subcategories: "nope" },
        { name: 1, subcategories: [] },
        "nope",
        null,
      ],
      "getterCategory",
    );
  });

  it("direct self-reference through .optional()", () => {
    const Employee = z.object({
      name: z.string(),
      get manager() {
        return Employee.optional();
      },
    });
    expectCompiled(Employee);
    expectParity(
      Employee,
      [
        { name: "a" },
        { name: "a", manager: { name: "b" } },
        { name: "a", manager: { name: "b", manager: { name: "c" } } },
        { name: "a", manager: { name: 2 } },
        { name: "a", manager: { name: "b", manager: { name: null } } },
        { name: "a", manager: null },
        { name: "a", manager: {} },
      ],
      "getterEmployee",
    );
  });

  it("non-root recursion target (cycle back to a sub-schema)", () => {
    const Comment = z.object({
      body: z.string(),
      get replies() {
        return z.array(Comment);
      },
    });
    const Post = z.object({ title: z.string(), thread: Comment });
    expectCompiled(Post);

    // The cycle returns to `thread`, not to the compiled root, so it must take
    // the same route a nested `z.lazy()` cycle does: a `recursionTarget` hosting
    // the sub-schema as its own validator, with the back-edge naming that id
    // rather than re-invoking the (wrong-shaped) root.
    const ir = extractSchema(Post) as {
      properties: Record<string, unknown>;
    };
    const thread = ir.properties["thread"] as {
      type: string;
      refId: number;
      inner: { properties: Record<string, { element: unknown }> };
    };
    expect(thread.type).toBe("recursionTarget");
    expect(thread.refId).toBe(1);
    expect(thread.inner.properties["replies"]?.element).toEqual({
      type: "recursiveRef",
      refId: 1,
    });

    expectParity(
      Post,
      [
        { title: "t", thread: { body: "b", replies: [] } },
        { title: "t", thread: { body: "b", replies: [{ body: "r", replies: [] }] } },
        {
          title: "t",
          thread: { body: "b", replies: [{ body: "r", replies: [{ body: "rr", replies: [] }] }] },
        },
        { title: "t", thread: { body: "b", replies: [{ body: 1, replies: [] }] } },
        { title: 1, thread: { body: "b", replies: [] } },
        { title: "t", thread: "nope" },
        { title: "t" },
      ],
      "getterPost",
    );
  });

  it("two back-edges to the same recursion target", () => {
    const Tree = z.object({
      value: z.number(),
      get left() {
        return Tree.nullable();
      },
      get right() {
        return Tree.nullable();
      },
    });
    const Doc = z.object({ tree: Tree });
    expectCompiled(Doc);

    // Both back-edges name the SAME hosted validator: the second one must reuse
    // the refId minted by the first, and detecting it at all depends on `Tree`
    // still being on the `visiting` stack after the first back-edge returned.
    const ir = extractSchema(Doc) as {
      properties: Record<string, { inner: { properties: Record<string, { inner: unknown }> } }>;
    };
    const node = ir.properties["tree"]?.inner.properties;
    expect(node?.["left"]?.inner).toEqual({ type: "recursiveRef", refId: 1 });
    expect(node?.["right"]?.inner).toEqual({ type: "recursiveRef", refId: 1 });

    expectParity(
      Doc,
      [
        { tree: { value: 1, left: null, right: null } },
        { tree: { value: 1, left: { value: 2, left: null, right: null }, right: null } },
        {
          tree: {
            value: 1,
            left: null,
            right: { value: 3, left: { value: 4, left: null, right: null }, right: null },
          },
        },
        { tree: { value: 1, left: { value: "x", left: null, right: null }, right: null } },
        { tree: { value: 1, left: null } },
        { tree: { value: 1, left: null, right: 5 } },
      ],
      "getterTree",
    );
  });

  it("getter cycle reached through a union", () => {
    const Shape = z.object({
      id: z.string(),
      get child() {
        return z.union([z.null(), Shape]);
      },
    });
    expectCompiled(Shape);
    expectParity(
      Shape,
      [
        { id: "a", child: null },
        { id: "a", child: { id: "b", child: null } },
        { id: "a", child: { id: "b", child: { id: "c", child: null } } },
        { id: "a", child: { id: 1, child: null } },
        { id: "a", child: 5 },
        { id: "a" },
      ],
      "getterUnion",
    );
  });

  it("getter cycle reached through a record", () => {
    const Dir = z.object({
      name: z.string(),
      get children() {
        return z.record(z.string(), Dir);
      },
    });
    expectCompiled(Dir);
    expectParity(
      Dir,
      [
        { name: "root", children: {} },
        { name: "root", children: { a: { name: "a", children: {} } } },
        {
          name: "root",
          children: { a: { name: "a", children: { b: { name: "b", children: {} } } } },
        },
        { name: "root", children: { a: { name: 1, children: {} } } },
        { name: "root", children: { a: "nope" } },
        { name: "root", children: null },
        { name: "root" },
      ],
      "getterDir",
    );
  });
});

// ─── Recursion back-edge refIds ─────────────────────────────────────────────
// A back-edge is keyed on the schema the cycle RE-ENTERS, and the id it carries
// decides which validator runs: refId 0 — encoded as an ABSENT `refId` — means
// "re-invoke the root's own safeParse_<name>", while any id ≥ 1 makes codegen
// host a separate validator for the target and call that instead. So an id that
// drifts from 0 to 1 costs a hosted helper and an extra call per recursion step
// while leaving every result identical, which no parity assertion can see —
// only the IR shape can. These pin it, because two detectors in different
// frames now mint those ids (`extractLazy` keyed on what a `z.lazy()` resolves
// to, `dispatch` keyed on a re-entered schema) and they must not disagree.

describe("recursion back-edge refIds", () => {
  it("root z.lazy() self-recursion keeps the implicit refId 0", () => {
    // The back-edge lands on the ROOT LAZY NODE itself (not on some inner
    // schema), so dispatch re-enters a lazy — the one case where the generic
    // getter-cycle guard must stand down and let extractLazy key the ref on the
    // schema the lazy RESOLVES to, which is what refId 0 identifies.
    const Lazy: z.ZodType = z.lazy(() => z.object({ n: z.number(), next: Lazy.optional() }));
    const ir = extractSchema(Lazy) as {
      type: string;
      properties: Record<string, { inner: unknown }>;
    };
    expect(ir.type).toBe("object");
    expect(ir.properties["next"]?.inner).toEqual({ type: "recursiveRef" });

    expectCompiled(Lazy);
    expectParity(
      Lazy,
      [
        { n: 1 },
        { n: 1, next: { n: 2 } },
        { n: 1, next: { n: 2, next: { n: 3 } } },
        { n: 1, next: { n: "x" } },
        { n: 1, next: null },
      ],
      "rootLazySelf",
    );
  });

  it("getter-declared root self-recursion keeps the implicit refId 0", () => {
    const Category = z.object({
      name: z.string(),
      get subs() {
        return z.array(Category);
      },
    });
    const ir = extractSchema(Category) as {
      type: string;
      properties: Record<string, { element: unknown }>;
    };
    expect(ir.type).toBe("object");
    expect(ir.properties["subs"]?.element).toEqual({ type: "recursiveRef" });
  });

  it("non-root target hosts one validator, lazy and getter alike", () => {
    const LazyInner: z.ZodType = z.object({
      v: z.string(),
      self: z.array(z.lazy(() => LazyInner)),
    });
    const GetterInner = z.object({
      v: z.string(),
      get self() {
        return z.array(GetterInner);
      },
    });
    const expected = {
      type: "recursionTarget",
      refId: 1,
      inner: {
        type: "object",
        properties: {
          v: { type: "string", checks: [] },
          self: { type: "array", element: { type: "recursiveRef", refId: 1 }, checks: [] },
        },
        stripUnknownKeys: true,
      },
    };
    for (const [label, Inner] of [
      ["lazy", LazyInner],
      ["getter", GetterInner],
    ] as const) {
      const ir = extractSchema(z.object({ node: Inner })) as {
        properties: Record<string, unknown>;
      };
      // Both declaration forms of one cycle must extract to the same hosted
      // target and the same back-edge id — the ref calls `__rsp_1`/`__fcr_1`,
      // and a mismatch would call a validator built for a different shape.
      expect(ir.properties["node"], `${label} non-root target`).toEqual(expected);
    }
  });

  it("mutual recursion still resolves back through the root", () => {
    const A: z.ZodType = z.object({ b: z.lazy(() => B).optional() });
    const B: z.ZodType = z.object({ a: z.lazy(() => A).optional() });
    const ir = extractSchema(A) as {
      properties: Record<string, { inner: { properties: Record<string, { inner: unknown }> } }>;
    };
    // A → B is inlined (B is not itself a cycle target); B → A closes the cycle
    // on the root, so it stays the implicit refId 0 rather than hosting B.
    expect(ir.properties["b"]?.inner.properties["a"]?.inner).toEqual({ type: "recursiveRef" });

    expectCompiled(A);
    expectParity(
      A,
      [{}, { b: {} }, { b: { a: {} } }, { b: { a: { b: {} } } }, { b: { a: 5 } }, { b: 5 }],
      "mutualRec",
    );
  });
});

// ─── Empty-valued enums ─────────────────────────────────────────────────────
// An enum whose accepted-value set is EMPTY is legal in Zod and rejects every
// input with `invalid_value` / `values: []`. Three public spellings reach it,
// and the third is the one nobody expects: `z.enum([1, 2])` — a NUMERIC ARRAY —
// becomes the entries `{1: 1, 2: 2}`, which Zod cannot tell apart from a TS
// numeric enum's reverse mapping, so its reverse-mapping filter strips the lot
// and leaves `_zod.values` empty.
//
// Codegen built both the slow walk's `&&` chain and the fast check's `||` chain
// by JOINING per-value comparisons, and an empty join is an empty STRING: the
// emitted source was `if(){...}` and `return ();`. That is not a divergence but
// a SyntaxError at Function-construction time, i.e. the whole compile died.

describe("empty-valued enums", () => {
  const spellings: [string, z.ZodType][] = [
    ["array", z.enum([])],
    ["object", z.enum({})],
    // Numeric array: entries {1:1, 2:2} → reverse-mapping filter empties values.
    ["numericArray", z.enum([1, 2] as never)],
  ];

  const inputs = ["a", "", "1", 1, 2, 0, -1, null, undefined, true, NaN, {}, [], Symbol("s")];

  for (const [label, schema] of spellings) {
    it(`z.enum (${label}) rejects everything, exactly as zod does`, () => {
      expectCompiled(schema);
      expectParity(schema, inputs, `emptyEnum_${label}`);
    });

    it(`z.enum (${label}) reports invalid_value with an empty values array`, () => {
      // expectParity compares issue code+path and the first message; the
      // `values` field itself is what zod fills from its (empty) value set, so
      // pin it here rather than trusting the code alone.
      const compiled = compileLikeProduction(schema, `emptyEnumValues_${label}`);
      const result = compiled("anything");
      expect(result.success).toBe(false);
      if (result.success) return;
      const issue = result.error.issues[0] as { code?: string; values?: unknown[] };
      expect(issue.code).toBe("invalid_value");
      expect(issue.values).toStrictEqual([]);
      // …and zod agrees.
      const zodResult = schema.safeParse("anything");
      expect(zodResult.success).toBe(false);
      if (zodResult.success) return;
      expect((zodResult.error.issues[0] as { values?: unknown[] }).values).toStrictEqual([]);
    });

    it(`z.enum (${label}) nested in containers keeps the fast check well-formed`, () => {
      // Nesting is what exercises the FAST path: the empty check is spliced
      // into a larger boolean expression, where an empty join would also have
      // wrecked the surrounding operator precedence.
      const obj = z.object({ ok: z.string(), bad: schema });
      expectCompiled(obj);
      expectParity(
        obj,
        [{ ok: "x", bad: "y" }, { ok: "x", bad: 1 }, { ok: 1, bad: "y" }, { ok: "x" }, {}, null],
        `emptyEnumObject_${label}`,
      );

      const arr = z.array(schema);
      expectCompiled(arr);
      expectParity(arr, [[], ["a"], [1], ["a", "b"], null, "nope"], `emptyEnumArray_${label}`);

      const opt = z.object({ v: schema.optional() });
      expectCompiled(opt);
      expectParity(opt, [{}, { v: undefined }, { v: "a" }, { v: 1 }], `emptyEnumOpt_${label}`);
    });
  }
});

// ─── Literal values with no JS source form ──────────────────────────────────
// `z.literal()` is TYPED as `util.Literal` (string | number | bigint | boolean |
// null | undefined), but its runtime is `new Set(def.values).has(input)` — so a
// SYMBOL is accepted at construction AND matched at parse time. Zod users do
// pass one (branded keys, registry symbols), and the schema genuinely works.
//
// Codegen rendered every literal through `literalToJs`, whose tail was
// `JSON.stringify` — and `JSON.stringify(aSymbol)` returns the VALUE `undefined`,
// not a string. So `z.literal(sym)` compiled to `input===undefined`: it REJECTED
// the very symbol it was built from and ACCEPTED `undefined`, a hole in both
// directions. `z.literal([sym, "b"])` compiled to `x===undefined||x==="b"` and
// reported `values:[,"b"]` — an array HOLE, since `join` renders `undefined` as
// the empty string. An OBJECT value broke the same way in one direction:
// `x==={}` is never true, so the object the schema was built from was rejected.
//
// The fix keeps the schema in `__rf[]` and tests `values.includes(input)`
// against its own `_zod.def.values`. `Array.prototype.includes` is SameValueZero
// — exactly what `Set.prototype.has` does — so the verdict matches zod's, and
// emitting that same array as the issue's `values` matches what zod reports.
//
// Delegating the literal to `__rf[N].safeParse` instead would have been WRONG,
// and the tests below pin why: zod's locale renders `invalid_value` through
// `stringifyPrimitive`, i.e. `` `${value}` ``, which is a TypeError on a symbol.
// A union DISCARDS a losing option's issues without ever formatting them, so
// `z.union([z.literal(sym), z.string()]).safeParse("a")` succeeds in zod — while
// a delegating arm would run a full safeParse and THROW on that same valid input.

describe("literal values with no JS source form", () => {
  const SYM = Symbol.for("zod-compiler.literal.k");
  const OTHER = Symbol.for("zod-compiler.literal.other");
  const OBJ = { tag: "identity" };

  /** The literal really compiled, retaining exactly one schema for its value list. */
  function expectRuntimeValuesCompiled(schema: unknown): void {
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as { type: string; refIndex?: number };
    expect(ir.type, "must compile, not delegate to zod").toBe("literal");
    expect(ir.refIndex, "must retain the schema to read def.values from").toBe(0);
    expect(refs, "exactly one retained schema").toHaveLength(1);
  }

  /**
   * Zod cannot even REPORT a symbol-literal mismatch — it throws while
   * formatting, from inside `safeParse`. The compiler defers every message to
   * the `.error` accessor, so `safeParse` returns a plain rejection and the
   * identical TypeError surfaces on the first `.error` read.
   */
  function expectDeferredFormatThrow(
    compiled: (input: unknown) => { success: boolean },
    schema: { safeParse: (input: unknown) => unknown },
    input: unknown,
  ): void {
    expect(() => schema.safeParse(input), "zod throws eagerly").toThrow(TypeError);
    const result = compiled(input) as
      | { success: true }
      | { success: false; readonly error: unknown };
    expect(result.success, "compiled rejects without throwing").toBe(false);
    if (result.success) return;
    expect(() => result.error, "compiled throws the same error, deferred").toThrow(TypeError);
  }

  it("accepts the symbol it was built from and rejects undefined", () => {
    const schema = z.literal(SYM as never);
    expectRuntimeValuesCompiled(schema);
    const compiled = compileLikeProduction(schema, "symLiteral");

    // The accept direction: zod accepts this, and so must the compiled form.
    expect(schema.safeParse(SYM).success).toBe(true);
    expect(compiled(SYM).success).toBe(true);

    // The reject direction: `undefined` was the value the broken comparison had
    // baked in, so it is the one input that must not sneak through.
    for (const input of [undefined, null, "k", 0, false, OTHER, Symbol("k")]) {
      expect(compiled(input).success, `rejects ${String(input)}`).toBe(false);
    }
  });

  it("reports the schema's own values array in the issue", () => {
    // Zod's invalid_value issue carries `def.values` — the array object itself,
    // not a copy — so the compiled issue must carry that same array. Pinned on
    // an OBJECT literal because a symbol one cannot be formatted at all: reading
    // `.error` is what throws (see the deferred-throw test).
    const schema = z.literal(OBJ as never);
    const defValues = (schema as unknown as { _zod: { def: { values: unknown[] } } })._zod.def
      .values;
    const compiled = compileLikeProduction(schema, "objLiteralIssue");

    const result = compiled("nope");
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues[0] as { code?: string; values?: unknown[] };
    expect(issue.code).toBe("invalid_value");
    expect(issue.values, "the schema's own array, by reference").toBe(defValues);

    // …and zod reports exactly that.
    const zodResult = schema.safeParse("nope");
    expect(zodResult.success).toBe(false);
    if (zodResult.success) return;
    expect((zodResult.error.issues[0] as { values?: unknown[] }).values).toBe(defValues);
  });

  it("mixed symbol + string literal keeps both values live", () => {
    const schema = z.literal([SYM, "b"] as never);
    expectRuntimeValuesCompiled(schema);
    const compiled = compileLikeProduction(schema, "symMixedLiteral");

    for (const input of [SYM, "b"]) {
      expect(schema.safeParse(input).success, `zod accepts ${String(input)}`).toBe(true);
      expect(compiled(input).success, `compiled accepts ${String(input)}`).toBe(true);
    }
    // `undefined` used to be accepted here too — the symbol collapsed into it
    // and left `x===undefined||x==="b"`.
    for (const input of [undefined, null, "a", "", 0]) {
      expect(compiled(input).success, `rejects ${String(input)}`).toBe(false);
    }
  });

  it("nested in containers", () => {
    const object = z.object({ kind: z.literal(SYM as never), n: z.number() });
    const compiledObject = compileLikeProduction(object, "symLiteralObject");
    expect(object.safeParse({ kind: SYM, n: 1 }).success).toBe(true);
    expect(compiledObject({ kind: SYM, n: 1 }).success).toBe(true);
    // A MISSING key reads as `undefined`, which the broken comparison accepted —
    // so a required symbol-tagged field was satisfied by omitting it entirely.
    expect(compiledObject({ n: 1 }).success).toBe(false);
    expect(compiledObject({ kind: undefined, n: 1 }).success).toBe(false);
    expect(compiledObject({ kind: OTHER, n: 1 }).success).toBe(false);

    const array = z.array(z.literal(SYM as never));
    const compiledArray = compileLikeProduction(array, "symLiteralArray");
    expect(compiledArray([]).success).toBe(true);
    expect(compiledArray([SYM, SYM]).success).toBe(true);
    expect(compiledArray([SYM, undefined]).success).toBe(false);

    const optional = z.object({ v: z.literal(SYM as never).optional() });
    const compiledOptional = compileLikeProduction(optional, "symLiteralOptional");
    expect(compiledOptional({}).success).toBe(true);
    expect(compiledOptional({ v: SYM }).success).toBe(true);
    expect(compiledOptional({ v: OTHER }).success).toBe(false);
  });

  it("a union arm with a symbol literal does not throw on input another arm accepts", () => {
    const union = z.union([z.literal(SYM as never), z.string()]);

    // The reason a zod FALLBACK is not an option: the literal alone throws on
    // exactly the input the union accepts, because a top-level safeParse
    // formats its issues while a union discards a losing option's unformatted.
    expect(() => z.literal(SYM as never).safeParse("a")).toThrow(TypeError);
    expect(union.safeParse("a").success).toBe(true);

    // Compiled must behave like the union, not like the bare literal.
    expectParity(union, [SYM, "a", ""], "symLiteralUnion");
    const compiled = compileLikeProduction(union, "symLiteralUnionThrow");
    expect(compiled("a").success).toBe(true);
    expect(compiled(SYM).success).toBe(true);
    // …and when the union really does fail, the throw is merely deferred.
    expectDeferredFormatThrow(compiled, union, 1);
  });

  it("defers zod's formatter TypeError to the .error accessor", () => {
    for (const [label, schema, bad] of [
      ["single", z.literal(SYM as never), "nope"],
      ["mixed", z.literal([SYM, "b"] as never), "nope"],
      ["object", z.object({ kind: z.literal(SYM as never) }), { kind: "nope" }],
    ] as [string, z.ZodType, unknown][]) {
      const compiled = compileLikeProduction(schema, `symLiteralDeferred_${label}`);
      expectDeferredFormatThrow(compiled, schema, bad);
    }
  });

  it("an object-valued literal takes the same path, with full issue parity", () => {
    // The guard is on "has a JS source form", not on "is a symbol": an object
    // stringifies to `"{}"`, so the old codegen emitted `x==={}` — never true,
    // so the schema rejected its own value. Zod's formatter handles objects, so
    // this case can be held to FULL parity, issues and messages included.
    const schema = z.literal(OBJ as never);
    expectRuntimeValuesCompiled(schema);
    expectParity(schema, [OBJ, { tag: "identity" }, {}, "nope", undefined, null], "objLiteral");

    const mixed = z.literal([OBJ, "b"] as never);
    expectParity(mixed, [OBJ, "b", { tag: "identity" }, "a", undefined], "objMixedLiteral");
  });

  it("a symbol discriminant never becomes switch dispatch", () => {
    // Auto-discrimination turns a large plain union into an O(1) switch over the
    // shared key's literal values — which needs a `case` LABEL per value, and a
    // symbol has none. `isSwitchableDiscriminant` must keep refusing it so the
    // union falls back to the `||`-chain, where each option's own literal check
    // reads the value list off the retained schema.
    const union = z.union([
      z.object({ k: z.literal(SYM as never), a: z.string() }),
      z.object({ k: z.literal("b"), a: z.string() }),
      z.object({ k: z.literal("c"), a: z.string() }),
      z.object({ k: z.literal("d"), a: z.string() }),
      z.object({ k: z.literal("e"), a: z.string() }),
    ]);
    expectParity(
      union,
      [
        { k: SYM, a: "x" },
        { k: "b", a: "x" },
        { k: "e", a: "x" },
      ],
      "symDiscriminant",
    );
  });

  it("a symbol-keyed record still delegates to zod", () => {
    // Compiled records walk their input with `for-in`, which yields string keys
    // only, so a symbol-valued key literal could never match — while zod's own
    // record enumerates differently. `isStringShapedKey` must keep refusing it.
    const refs: RefEntry[] = [];
    const ir = extractSchema(z.partialRecord(z.literal(SYM as never), z.string()), refs);
    expect(ir.type, "symbol-keyed record must not compile").toBe("fallback");
  });
});

// ─── Discriminated-union dispatch on the build path ─────────────────────────
// Zod resolves a discriminated union through a `discriminator value → option`
// map built from each option's `_zod.propValues`. An input whose discriminator
// misses that map is rejected outright with `invalid_union` ("No matching
// discriminator") — no option's own parse ever runs.
//
// The build path (the single pass that validates and assembles rewritten output
// together, reached only when something in the schema mutates) handled
// `discriminatedUnion` in the same case as a plain `union`: probe the options in
// declaration order, take the first that builds. That is only equivalent while
// every option accepts EXACTLY its dispatch values, and a value-substituting
// wrapper on the discriminator breaks it — `z.literal("a").default("a")`
// contributes the single dispatch value `"a"` to `propValues` while its own
// parse also accepts a MISSING `t`. So `{v:"x"}` was accepted, and returned
// `{t:"a",v:"x"}`, where zod rejects. The `.default()` is also what pulls the
// schema onto the build path in the first place, so the two arrive together.
//
// `.prefault()` and `.catch()` have the same shape but do not reach this pass
// today (a prefaulted schema delegates to zod wholesale; `.catch()` is refused
// by `mutatesBeyondStrip` and keeps the eager walk, which already switches).
// They are pinned anyway so a later coverage widening cannot reintroduce the
// hole silently.
//
// The opposite error would be refusing every wrapped discriminator: `.optional()`
// and `.nullable()` are NOT bugs, because their `undefined`/`null` genuinely ARE
// in `propValues` and so are legitimate dispatch values. Those must stay
// compiled, on the build path, and keep matching zod.

/** The build-path entry function's body, or null when no build pass was emitted. */
function buildEntryBody(schema: unknown): string | null {
  const refs: RefEntry[] = [];
  const ir = extractSchema(schema, refs);
  const { code, functionDef } = generateValidator(ir, "du", { refCount: refs.length });
  const entry = /=(__vb_\d+)\(input\)/.exec(functionDef)?.[1];
  if (entry === undefined) return null;
  // Every preamble entry is emitted as its own line.
  return code.split("\n").find((line) => line.startsWith(`function ${entry}(`)) ?? null;
}

describe("discriminated-union dispatch on the build path", () => {
  /** Two options whose second is unreachable by dispatch from the first's values. */
  const withDiscriminator = (t: z.ZodType): z.ZodType =>
    z.discriminatedUnion("t", [
      z.object({ t: t as never, v: z.string() }),
      z.object({ t: z.literal("b"), v: z.number() }),
    ]) as unknown as z.ZodType;

  /** Inputs that separate dispatch from sequential probing. */
  const INPUTS = [
    { v: "x" }, // discriminator ABSENT — the case that regressed
    { t: "a", v: "x" },
    { t: "b", v: 1 },
    { t: "zzz", v: "x" }, // discriminator present but unlisted
    { t: null, v: "x" },
    { t: "a", v: 1 }, // dispatches to "a", then fails on its own field
    [],
    null,
    undefined,
    "nope",
  ];

  it("a .default() discriminator dispatches instead of probing", () => {
    const schema = withDiscriminator(z.literal("a").default("a"));
    expectParity(schema, INPUTS, "duDefault");

    const body = buildEntryBody(schema);
    expect(body, "the .default() must pull the schema onto the build path").not.toBeNull();
    expect(body, "object-ness proved before the discriminator is read").toContain(
      'if(typeof input!=="object"||input===null||Array.isArray(input))return',
    );
    expect(body, "dispatches on the discriminator").toContain('switch(input["t"])');
    expect(body, "an unlisted discriminator fails outright").toMatch(/default:return __bf_\d+;/);
  });

  it("a .prefault() discriminator matches zod", () => {
    expectParity(withDiscriminator(z.literal("a").prefault("a")), INPUTS, "duPrefault");
  });

  it("a .catch() discriminator matches zod", () => {
    expectParity(withDiscriminator(z.literal("a").catch("a")), INPUTS, "duCatch");
  });

  it("a .catch() discriminator alongside a rebuilding field matches zod", () => {
    const schema = z.discriminatedUnion("t", [
      z.object({ t: z.literal("a").catch("a"), v: z.string().trim() }),
      z.object({ t: z.literal("b"), v: z.number() }),
    ]);
    expectParity(schema, [...INPUTS, { t: "a", v: " x " }], "duCatchTrim");
  });

  it("an .optional() discriminator stays compiled — undefined IS a dispatch value", () => {
    const schema = z.discriminatedUnion("t", [
      z.object({ t: z.literal("a").optional(), v: z.string().trim() }),
      z.object({ t: z.literal("b"), v: z.number() }),
    ]);
    expectCompiled(schema);
    expectParity(
      schema,
      [...INPUTS, { t: undefined, v: " x " }, { t: "a", v: " x " }],
      "duOptional",
    );
    expect(buildEntryBody(schema), "undefined is an ordinary case arm").toContain(
      "case undefined:",
    );
  });

  it("a .nullable() discriminator stays compiled — null IS a dispatch value", () => {
    const schema = z.discriminatedUnion("t", [
      z.object({ t: z.literal("a").nullable(), v: z.string().trim() }),
      z.object({ t: z.literal("b"), v: z.number() }),
    ]);
    expectCompiled(schema);
    expectParity(schema, [...INPUTS, { t: null, v: " x " }], "duNullable");
    expect(buildEntryBody(schema), "null is an ordinary case arm").toContain("case null:");
  });

  it("a multi-value literal discriminator shares ONE hosted build across its cases", () => {
    const schema = z.discriminatedUnion("t", [
      z.object({ t: z.literal(["a", "c"]), v: z.string().trim() }),
      z.object({ t: z.literal("b"), v: z.number() }),
    ]);
    expectParity(schema, [...INPUTS, { t: "c", v: " x " }, { t: "a", v: " x " }], "duMultiLiteral");

    const body = buildEntryBody(schema) ?? "";
    expect(body.match(/case /g), "one arm per discriminator value").toHaveLength(3);
    expect(
      // `=__vb_N(input)` is a CALL from a case arm; the entry's own
      // `function __vb_M(input){` header has no `=` and is not counted.
      new Set(body.match(/=__vb_\d+\(input\)/g)).size,
      "one hosted build per REACHABLE option, not per case",
    ).toBe(2);
  });

  it("a rebuilding non-discriminator field alone reaches the dispatching build", () => {
    // Nothing wraps the discriminator here: the `.trim()` is what makes the
    // schema rebuild, so this pins that ordinary discriminated unions keep the
    // build path (a regression here is a silent slowdown, not a wrong answer).
    const schema = z.discriminatedUnion("t", [
      z.object({ t: z.literal("a"), v: z.string().trim() }),
      z.object({ t: z.literal("b"), v: z.number() }),
    ]);
    expectCompiled(schema);
    expectParity(schema, [...INPUTS, { t: "a", v: " x " }], "duTrim");
    expect(buildEntryBody(schema), "still dispatches").toContain('switch(input["t"])');
  });
});

// ─── Discriminators the compiled dispatch cannot represent ──────────────────
// Zod resolves a discriminated union through a `Map` built from each option's
// `propValues`, read as `map.get(input[disc])` — i.e. SameValueZero. Every
// compiled dispatch form is `===`-shaped instead: the slow walk's `switch`, the
// fast check's `switch`, the build pass's `switch`, and the ordinal variant's
// string-keyed property lookup. The two agree on every value but ONE — `NaN`,
// which SameValueZero matches against itself and `===` does not. So
// `z.literal(NaN)` contributed a `case NaN:` that is dead code, and the input
// zod happily routes fell through to the "No matching discriminator" arm: zod
// ACCEPTED `{t:NaN,v:1}` while the compiled form rejected it, on the fast path,
// the build path and the slow walk alike. `isSwitchableDiscriminant` already
// refuses NaN on the plain-union auto-discrimination path for this exact reason;
// `z.discriminatedUnion` had no such guard, and the `seenValues` Set could only
// ever have caught a DUPLICATE NaN, not a lone one.
//
// `{ unionFallback: true }` is the second shape the discriminated IR cannot
// hold. On a dispatch MISS zod does not report "No matching discriminator" — it
// runs `_super(payload, ctx)`, $ZodUnion's own parse, retrying every option.
// That changes the error SHAPE (a plain `invalid_union` at path `[]` carrying
// per-option `errors`, versus the discriminator-tagged issue at `[disc]`) and
// also the VERDICT wherever an option accepts input the dispatch table never
// routes to it — `z.literal("a").default("a")` contributes only `"a"` to
// `propValues` while its own parse also accepts a MISSING key, so `{v:"x"}`
// misses dispatch yet the plain-union retry accepts it and defaults `t`.
//
// Both delegate to Zod, which is parity by construction. The controls pin that
// nothing ELSE started delegating with them.

describe("discriminators the compiled dispatch cannot represent", () => {
  /** The root IR type — "discriminatedUnion" when it really compiled. */
  function rootIrType(schema: unknown): string {
    return (extractSchema(schema, []) as { type: string }).type;
  }

  const NAN_INPUTS = [
    { t: NaN, v: 1 },
    { t: NaN, v: "wrong" },
    { t: "b", v: "x" },
    { t: "b", v: 1 },
    { t: "zzz", v: 1 },
    { v: 1 },
    { t: 0, v: 1 },
    null,
    "nope",
    [],
  ];

  it("a NaN discriminator delegates to zod instead of emitting a dead case arm", () => {
    const schema = z.discriminatedUnion("t", [
      z.object({ t: z.literal(NaN), v: z.number() }),
      z.object({ t: z.literal("b"), v: z.string() }),
    ]);
    expect(rootIrType(schema), "NaN cannot be a `===` case label").toBe("fallback");
    expectParity(schema as unknown as ZodLikeSchema, NAN_INPUTS, "duNaN");
  });

  it("a NaN discriminator diverges on the FAST path too, nested in containers", () => {
    // Nesting is what runs the boolean fast check (`__du_N(x)`), which is a
    // separate `switch` from the slow walk's — both had the dead `case NaN:`.
    const du = z.discriminatedUnion("t", [
      z.object({ t: z.literal(NaN), v: z.number() }),
      z.object({ t: z.literal("b"), v: z.string() }),
    ]);
    expectParity(
      z.object({ u: du as never }),
      NAN_INPUTS.map((i) => ({ u: i })),
      "duNaNNested",
    );
    expectParity(
      z.array(du as never),
      NAN_INPUTS.map((i) => [i]),
      "duNaNArray",
    );
  });

  it("a NaN discriminator alongside 3+ string cases (ordinal-table dispatch)", () => {
    // With three or more all-string values the fast path switches to a
    // string-keyed ordinal TABLE — `tbl[t]`, a property lookup, which coerces
    // NaN to the key `"NaN"` rather than matching it. One non-string value keeps
    // the plain switch, but the guard has to hold for both shapes.
    const schema = z.discriminatedUnion("t", [
      z.object({ t: z.literal(NaN), v: z.number() }),
      z.object({ t: z.literal("b"), v: z.string() }),
      z.object({ t: z.literal("c"), v: z.string() }),
      z.object({ t: z.literal("d"), v: z.string() }),
    ]);
    expect(rootIrType(schema)).toBe("fallback");
    expectParity(
      schema as unknown as ZodLikeSchema,
      [...NAN_INPUTS, { t: "c", v: "x" }, { t: "d", v: 1 }],
      "duNaNTable",
    );
  });

  it("NaN reached through an enum-shaped multi-value literal also delegates", () => {
    // The guard sits inside the per-VALUE loop, not on the option, so a literal
    // that lists NaN among ordinary values is caught the same way.
    const schema = z.discriminatedUnion("t", [
      z.object({ t: z.literal(["a", NaN]), v: z.number() }),
      z.object({ t: z.literal("b"), v: z.string() }),
    ]);
    expect(rootIrType(schema)).toBe("fallback");
    expectParity(
      schema as unknown as ZodLikeSchema,
      [...NAN_INPUTS, { t: "a", v: 1 }, { t: "a", v: "x" }],
      "duNaNMulti",
    );
  });

  it("{ unionFallback: true } delegates — a miss retries every option", () => {
    const schema = z.discriminatedUnion(
      "t",
      [
        z.object({ t: z.literal("a"), v: z.string() }),
        z.object({ t: z.literal("b"), v: z.number() }),
      ],
      { unionFallback: true },
    );
    expect(rootIrType(schema), "the retry has no discriminated-IR form").toBe("fallback");
    expectParity(
      schema as unknown as ZodLikeSchema,
      [
        { t: "a", v: "x" },
        { t: "b", v: 1 },
        // The misses: zod reports a plain `invalid_union` at path `[]` with the
        // options' own errors, not the "No matching discriminator" issue at `["t"]`.
        { t: "zzz", v: "x" },
        { v: "x" },
        { t: null, v: "x" },
        { t: "a", v: 1 },
        null,
        "nope",
      ],
      "duUnionFallback",
    );
  });

  it("{ unionFallback: true } changes the VERDICT, not just the message", () => {
    // `.default()` on the discriminator: `propValues` holds only `"a"`, so `{}`
    // misses dispatch — but the retry runs option 0's own parse, which defaults
    // the absent `t` and ACCEPTS. Compiled dispatch alone rejected it outright.
    const schema = z.discriminatedUnion(
      "t",
      [
        z.object({ t: z.literal("a").default("a"), v: z.string() }),
        z.object({ t: z.literal("b"), v: z.number() }),
      ],
      { unionFallback: true },
    );
    expect(rootIrType(schema)).toBe("fallback");
    expect(schema.safeParse({ v: "x" }), "zod accepts and defaults t").toEqual({
      success: true,
      data: { t: "a", v: "x" },
    });
    expectParity(
      schema as unknown as ZodLikeSchema,
      [{ v: "x" }, { t: "a", v: "x" }, { t: "b", v: 1 }, { t: "zzz", v: "x" }, { v: 1 }],
      "duUnionFallbackVerdict",
    );
  });

  it("CONTROL: every other discriminator kind still compiles to dispatch", () => {
    const kinds: [string, unknown, unknown[]][] = [
      [
        "number",
        z.discriminatedUnion("t", [
          z.object({ t: z.literal(1), v: z.number() }),
          z.object({ t: z.literal(2), v: z.string() }),
        ]),
        [
          { t: 1, v: 1 },
          { t: 2, v: "x" },
          { t: 3, v: 1 },
          { t: 1, v: "x" },
        ],
      ],
      [
        // -0 and 0 are the SAME key under both SameValueZero and `===`, so a
        // `case -0:` (emitted as `case 0:`) routes exactly what zod's Map does.
        "negativeZero",
        z.discriminatedUnion("t", [
          z.object({ t: z.literal(-0), v: z.number() }),
          z.object({ t: z.literal(1), v: z.string() }),
        ]),
        [
          { t: -0, v: 1 },
          { t: 0, v: 1 },
          { t: 1, v: "x" },
          { t: -0, v: "x" },
          { t: 2, v: 1 },
        ],
      ],
      [
        "infinity",
        z.discriminatedUnion("t", [
          z.object({ t: z.literal(Number.POSITIVE_INFINITY), v: z.number() }),
          z.object({ t: z.literal(Number.NEGATIVE_INFINITY), v: z.string() }),
        ]),
        [
          { t: Number.POSITIVE_INFINITY, v: 1 },
          { t: Number.NEGATIVE_INFINITY, v: "x" },
          { t: 0, v: 1 },
          { t: Number.POSITIVE_INFINITY, v: "x" },
        ],
      ],
      [
        "bigint",
        z.discriminatedUnion("t", [
          z.object({ t: z.literal(1n), v: z.number() }),
          z.object({ t: z.literal(2n), v: z.string() }),
        ]),
        [
          { t: 1n, v: 1 },
          { t: 2n, v: "x" },
          { t: 3n, v: 1 },
          { t: 1, v: 1 },
        ],
      ],
      [
        "boolean",
        z.discriminatedUnion("t", [
          z.object({ t: z.literal(true), v: z.number() }),
          z.object({ t: z.literal(false), v: z.string() }),
        ]),
        [
          { t: true, v: 1 },
          { t: false, v: "x" },
          { t: 1, v: 1 },
          { t: true, v: "x" },
        ],
      ],
      [
        "null",
        z.discriminatedUnion("t", [
          z.object({ t: z.null(), v: z.number() }),
          z.object({ t: z.literal("b"), v: z.string() }),
        ]),
        [
          { t: null, v: 1 },
          { t: "b", v: "x" },
          { t: undefined, v: 1 },
          { t: null, v: "x" },
        ],
      ],
      [
        // Truthiness is the test zod itself applies (`if (def.unionFallback)`),
        // so an explicit `false` must keep dispatching.
        "unionFallbackFalse",
        z.discriminatedUnion(
          "t",
          [
            z.object({ t: z.literal("a"), v: z.string() }),
            z.object({ t: z.literal("b"), v: z.number() }),
          ],
          { unionFallback: false },
        ),
        [{ t: "a", v: "x" }, { t: "b", v: 1 }, { t: "zzz", v: "x" }, { v: "x" }],
      ],
    ];

    for (const [label, schema, inputs] of kinds) {
      expect(rootIrType(schema), `${label} must still compile to dispatch`).toBe(
        "discriminatedUnion",
      );
      expectCompiled(schema);
      expectParity(schema as ZodLikeSchema, inputs, `duControl_${label}`);
    }
  });
});

// ─── Intersections that can report unrecognized keys ────────────────────────
// Zod does NOT take the union of the two sides' unrecognized_keys issues. Its
// `handleIntersectionResults` collects the bare key NAMES each side reported,
// then emits `[...unrecKeys].filter(([, f]) => f.l && f.r)` — "Report only keys
// unrecognized by BOTH sides". A strict side's complaint about `b` is therefore
// CANCELLED by the other side declaring or tolerating `b`. The compiled two-pass
// run applied each side's strictness on its own, with nothing pairing the key
// sets, so it rejected input Zod accepts. Worse on the merged single-object
// path, where the cold walk re-asks Zod and agrees — yielding a rejection with
// an EMPTY issue list. The pairing is path-blind (it matches names across the
// flat issue lists), so a nested strict object counts too.

describe("intersections that can report unrecognized keys", () => {
  it("a strict side's complaint is cancelled by a loose side declaring the key", () => {
    expectParity(
      z.intersection(z.strictObject({ a: z.string() }), z.looseObject({ b: z.number() })),
      [{ a: "x", b: 1 }, { a: "x" }, { a: "x", b: 1, c: true }, { b: 1 }, "nope"],
      "strictLoose",
    );
    // Side order must not matter: the reconciliation is symmetric.
    expectParity(
      z.intersection(z.looseObject({ b: z.number() }), z.strictObject({ a: z.string() })),
      [{ a: "x", b: 1 }, { a: "x", b: 1, c: true }, { a: "x" }],
      "looseStrict",
    );
  });

  it("strict ∩ strict still rejects a key NEITHER side declares", () => {
    const both = z.intersection(
      z.strictObject({ a: z.string(), b: z.number() }),
      z.strictObject({ a: z.string(), b: z.number() }),
    );
    // `c` is unrecognized by both sides, so it survives reconciliation — as ONE
    // issue, not one per side.
    expect(both.safeParse({ a: "x", b: 1, c: true }).success).toBe(false);
    expectParity(
      both,
      [
        { a: "x", b: 1 },
        { a: "x", b: 1, c: true },
        { a: "x", b: 1, c: true, d: 1 },
      ],
      "strictStrict",
    );
    // Disjoint strict shapes cancel each other out entirely: each side's only
    // complaint is a key the other side declares, so Zod ACCEPTS.
    const disjoint = z.intersection(
      z.strictObject({ a: z.string() }),
      z.strictObject({ b: z.number() }),
    );
    expect(disjoint.safeParse({ a: "x", b: 1 }).success).toBe(true);
    expectParity(
      disjoint,
      [
        { a: "x", b: 1 },
        { a: "x", b: 1, c: true },
      ],
      "strictDisjoint",
    );
  });

  it("a strict object NESTED in a property participates in the reconciliation", () => {
    expectParity(
      z.intersection(
        z.looseObject({ n: z.strictObject({ a: z.string() }) }),
        z.looseObject({ n: z.looseObject({ b: z.number() }) }),
      ),
      [{ n: { a: "x", b: 1 } }, { n: { a: "x" } }, { n: { a: "x", b: 1, zz: 1 } }],
      "nestedStrictProp",
    );
    // Same shape on the merged-object path: two disjoint STRIP objects clear
    // mergeDisjointStripObjects' top-level strict bail, so only a deep walk
    // catches the nested strict.
    expectParity(
      z.intersection(
        z.object({ n: z.strictObject({ a: z.string() }) }),
        z.object({ m: z.number() }),
      ),
      [
        { m: 2, n: { a: "x", extra: 1 } },
        { m: 2, n: { a: "x" } },
      ],
      "mergedNestedStrict",
    );
  });

  it("a strict object NESTED in an array element participates too", () => {
    expectParity(
      z.intersection(
        z.looseObject({ list: z.array(z.strictObject({ a: z.string() })) }),
        z.looseObject({ list: z.array(z.looseObject({ b: z.number() })) }),
      ),
      [{ list: [{ a: "x", b: 1 }] }, { list: [] }, { list: [{ a: "x" }] }],
      "nestedStrictArray",
    );
    expectParity(
      z.intersection(
        z.object({ l: z.array(z.strictObject({ a: z.string() })) }),
        z.object({ m: z.number() }),
      ),
      [
        { l: [{ a: "x", extra: 1 }], m: 2 },
        { l: [{ a: "x" }], m: 2 },
      ],
      "mergedNestedStrictArray",
    );
  });

  it("a plain non-strict intersection still compiles", () => {
    const schema = z.intersection(
      z.looseObject({ a: z.string() }),
      z.looseObject({ b: z.number() }),
    );
    const ir = extractSchema(schema, []) as { type: string };
    expect(ir.type, "no side can report unrecognized keys").toBe("intersection");
    expectCompiled(schema);
    expectParity(
      schema,
      [
        { a: "x", b: 1, c: true },
        { a: "x", b: 1 },
        { a: 1, b: 1 },
      ],
      "plainAnd",
    );
  });
});

// ─── Records whose KEY schema rewrites its input ────────────────────────────
// z.record(z.string().toUpperCase(), z.number()) RE-HOMES each entry: zod parses
// the key, then writes the value under the PARSED key, so `{ a: 1 }` parses to
// `{ A: 1 }`. The compiled record used to reassign the for-in loop variable and
// then read the value back as `input[rewrittenKey]` — a key the input object
// does not have — so the entry failed with `invalid_type` at the rewritten path
// while zod accepted it. And because that walk returns its input by reference,
// it could not have produced the moved entry even with the lookup fixed. Both
// halves are why such a key delegates to zod outright.

describe("records with a rewriting key schema", () => {
  /** Extraction really produced a compiled record, not a delegation to Zod. */
  function expectRecordIr(schema: unknown): void {
    const ir = extractSchema(schema, []) as { type: string };
    expect(ir.type, "key schema does not rewrite, so the record must compile").toBe("record");
    expectCompiled(schema);
  }

  it(".toUpperCase() key re-homes the entry", () => {
    expectParity(
      z.record(z.string().toUpperCase(), z.number()),
      [
        { a: 1 },
        { A: 1 },
        { a: 1, b: 2 },
        // Two keys normalize onto one — zod's rebuilt output keeps the last.
        { A: 2, a: 1 },
        { a: "x" },
        {},
        "nope",
        null,
        [],
      ],
      "recUpperKey",
    );
  });

  it(".trim() key re-homes the entry", () => {
    expectParity(
      z.record(z.string().trim(), z.number()),
      [{ " a ": 1 }, { a: 1 }, { " a ": 1, "  b": 2 }, { " a ": "x" }, {}, 7],
      "recTrimKey",
    );
  });

  it("z.url() key normalizes the href", () => {
    // z.url()'s check writes `new URL(value).href` back, so it rewrites even
    // keys that already look clean ("https://example.com" gains a trailing "/").
    expectParity(
      z.record(z.url(), z.number()),
      [
        { "https://example.com": 1 },
        { "https://example.com/ ": 1 },
        { "https://example.com/": 1 },
        { "not a url": 1 },
        { "https://example.com/": "x" },
        {},
      ],
      "recUrlKey",
    );
  });

  it("non-rewriting key schemas still compile", () => {
    expectRecordIr(z.record(z.string(), z.number()));
    expectRecordIr(z.record(z.string().min(2), z.number()));
    expectRecordIr(z.record(z.string().regex(/^k/), z.number()));
    // z.email() only tests a regex — unlike z.url() it never writes back.
    expectRecordIr(z.record(z.email(), z.number()));
    expectRecordIr(z.record(z.templateLiteral(["id_", z.number()]), z.number()));

    expectParity(z.record(z.string(), z.number()), [{ a: 1 }, { a: "x" }, {}], "recPlainKey");
    expectParity(
      z.record(z.string().min(2), z.number()),
      [{ ab: 1 }, { a: 1 }, {}],
      "recMinLenKey",
    );
    expectParity(z.record(z.string().regex(/^k/), z.number()), [{ k1: 1 }, { x: 1 }], "recReKey");
    expectParity(z.record(z.email(), z.number()), [{ "a@b.com": 1 }, { nope: 1 }], "recEmailKey");
    expectParity(
      z.record(z.templateLiteral(["id_", z.number()]), z.number()),
      [{ id_1: 1 }, { id_x: 1 }],
      "recTemplateKey",
    );
  });
});

// ─── Issue FIELDS, not just code and path ───────────────────────────────────
// `expectParity` compares each issue's code, its path, and the first message —
// it never looks at the rest of the issue object. Four field-level divergences
// shipped under a green suite behind that blind spot:
//
//   tuple too_small       invented `inclusive: false`. Zod's $ZodTuple writes
//                         the two halves of one ternary asymmetrically —
//                         `{code:"too_big", maximum, inclusive:true}` but a bare
//                         `{code:"too_small", minimum}` — so the key is ABSENT,
//                         which is not the same as present-and-false.
//   z.stringbool()        dropped `expected:"stringbool"`. Its codec transform
//                         is the only `invalid_value` producer that carries an
//                         `expected` (enum and literal push `values` alone).
//   z.templateLiteral()   reported the slash-wrapped `/source/`.
//                         $ZodTemplateLiteral pushes `pattern.source` BARE;
//                         only string-format checks use `pattern.toString()`.
//   discriminated union   invented `options:[...]` on the no-match issue. Zod
//                         never enumerates the valid discriminator values.
//
// Each case pins ZOD's own key set literally, so an upstream field change
// surfaces here as a failure instead of as a silent shape drift, and then
// requires the compiled issue — in BOTH emit modes — to equal zod's field for
// field. The controls are the neighbouring shapes that legitimately DO carry
// the field in question and must not move.

describe("issue fields beyond code and path", () => {
  function firstIssue(result: {
    success: boolean;
    error?: { issues: unknown[] };
  }): Record<string, unknown> {
    expect(result.success, "input must be rejected for there to be an issue").toBe(false);
    return result.error?.issues[0] as Record<string, unknown>;
  }

  /**
   * Pin zod's key set, then require both emit modes to reproduce zod's issue
   * field for field. `expectedKeys` is written out literally (sorted) so an
   * upstream field addition or removal fails loudly rather than propagating.
   */
  function expectIssueFields(
    schema: ZodLikeSchema,
    input: unknown,
    name: string,
    expectedKeys: string[],
  ): void {
    const zodIssue = firstIssue(
      schema.safeParse(input) as { success: boolean; error?: { issues: unknown[] } },
    );
    expect(Object.keys(zodIssue).sort(), `zod's own issue keys for ${name}`).toStrictEqual(
      expectedKeys,
    );
    const modes = [
      ["inline", compileLikeProduction(schema, name)],
      ["lean", compileLeanLikeProduction(schema, `${name}Lean`)],
    ] as const;
    for (const [mode, compiled] of modes) {
      const issue = firstIssue(
        compiled(input) as unknown as { success: boolean; error?: { issues: unknown[] } },
      );
      expect(issue, `${mode} issue fields for ${name}`).toStrictEqual(zodIssue);
    }
  }

  it("tuple length issues: too_small and too_big both spell out `inclusive: true`", () => {
    const pair = z.tuple([z.string(), z.number()]);
    expectCompiled(pair);
    // zod's under-length push mirrors its over-length one: `{ code, minimum,
    // inclusive: true, ..., origin }`, phrased ">=2 items" by the locale.
    const keys = ["code", "inclusive", "message", "minimum", "origin", "path"];
    expectIssueFields(pair, [], "tupleTooSmall", keys);
    expectIssueFields(pair, ["a", 1, 2], "tupleTooBig", [
      "code",
      "inclusive",
      "maximum",
      "message",
      "origin",
      "path",
    ]);
    // An omittable tail moves `optStart` (the `minimum`), not the issue's shape.
    const withOptionalTail = z.tuple([z.string(), z.number(), z.string().optional()]);
    expectCompiled(withOptionalTail);
    expectIssueFields(withOptionalTail, [], "tupleOptTailTooSmall", keys);
  });

  it('an absent required key reports `invalid_type` with `expected: "nonoptional"`', () => {
    // Pushed by $ZodObject itself, `code` first and without an `inst` — so the
    // object's own `error` does not reach it where it reaches every other
    // issue the node creates.
    const required = z.object({ a: z.any() }, { error: "object-level" });
    expectCompiled(required);
    expectIssueFields(required, {}, "nonoptionalKey", ["code", "expected", "message", "path"]);
    expect(compileLikeProduction(required)({}).error?.issues[0]?.message).toBe(
      "Invalid input: expected nonoptional, received undefined",
    );
    expect(compileLikeProduction(required)(1).error?.issues[0]?.message).toBe("object-level");
  });

  it("CONTROL: check-created size issues still carry `inclusive`", () => {
    // These come from $ZodCheckMinLength/$ZodCheckMaxLength etc., which set
    // `inclusive` unconditionally — the tuple fix must not reach them.
    expectIssueFields(z.array(z.string()).min(2), ["a"], "arrayMin", [
      "code",
      "inclusive",
      "message",
      "minimum",
      "origin",
      "path",
    ]);
    expectIssueFields(z.array(z.string()).max(1), ["a", "b"], "arrayMax", [
      "code",
      "inclusive",
      "maximum",
      "message",
      "origin",
      "path",
    ]);
    expectIssueFields(z.array(z.string()).length(2), ["a"], "arrayLengthShort", [
      "code",
      "exact",
      "inclusive",
      "message",
      "minimum",
      "origin",
      "path",
    ]);
    expectIssueFields(z.array(z.string()).length(2), ["a", "b", "c"], "arrayLengthLong", [
      "code",
      "exact",
      "inclusive",
      "maximum",
      "message",
      "origin",
      "path",
    ]);
    // The sharpest control for "omit is not false": `.gt()` reports a real
    // `inclusive: false`, which the value comparison below pins.
    expectIssueFields(z.number().gt(5), 5, "numberGt", [
      "code",
      "inclusive",
      "message",
      "minimum",
      "origin",
      "path",
    ]);
    expect(
      (z.number().gt(5).safeParse(5) as { error?: { issues: { inclusive?: unknown }[] } }).error
        ?.issues[0]?.inclusive,
      "zod really writes inclusive:false here",
    ).toBe(false);
  });

  it("z.stringbool() carries `expected`, on both of its emitted lookups", () => {
    // The two paths differ only in how the value is looked up (see
    // stringBoolUsesInline): a Map for the default 6-truthy/6-falsy set, an
    // `===` chain once each side is at or under ENUM_INLINE_THRESHOLD. Both
    // build the same issue, so both are pinned — and the path each takes is
    // asserted, so a threshold change cannot quietly collapse the coverage.
    const mapPath = z.stringbool();
    const chainPath = z.stringbool({ truthy: ["yes", "y"], falsy: ["no", "n"] });
    expectCompiled(mapPath);
    expectCompiled(chainPath);
    expect(stringBoolUsesInline(extractSchema(mapPath, []) as StringBoolIR)).toBe(false);
    expect(stringBoolUsesInline(extractSchema(chainPath, []) as StringBoolIR)).toBe(true);

    const keys = ["code", "expected", "message", "path", "values"];
    expectIssueFields(mapPath, "nope", "stringBoolMap", keys);
    expectIssueFields(chainPath, "nope", "stringBoolChain", keys);
  });

  it("CONTROL: enum and literal invalid_value carry no `expected`", () => {
    const keys = ["code", "message", "path", "values"];
    expectIssueFields(z.enum(["a", "b"]), "c", "enumInvalidValue", keys);
    expectIssueFields(z.literal("a"), "b", "literalInvalidValue", keys);
  });

  it("z.templateLiteral() reports the bare pattern source", () => {
    const keys = ["code", "format", "message", "path", "pattern"];
    // Not rewritten: the emitted regex's own `.source` is the original.
    const plain = z.templateLiteral(["u_", z.number()]);
    expectCompiled(plain);
    expectIssueFields(plain, "nope", "templateLiteralPlain", keys);
    // Rewritten (the `{n}` repeats unroll), so the ORIGINAL source has to be
    // carried separately — the runtime regex no longer holds it.
    const rewritten = z.templateLiteral(["id_", z.uuid()]);
    expectCompiled(rewritten);
    expectIssueFields(rewritten, "nope", "templateLiteralRewritten", keys);
    // Sharpest case: a template literal whose whole pattern IS a well-known
    // regex source. Lean mode used to short-circuit that to the shared
    // `<name>Src` export, which holds the SLASH-WRAPPED form that string-format
    // checks want and a template literal must not have.
    const wellKnown = z.templateLiteral([z.email()]);
    expectCompiled(wellKnown);
    expectIssueFields(wellKnown, "nope", "templateLiteralWellKnown", keys);
    expect(
      (
        z.templateLiteral(["u_", z.number()]).safeParse("nope") as {
          error?: { issues: { pattern?: unknown }[] };
        }
      ).error?.issues[0]?.pattern,
      "zod's template-literal pattern has no enclosing slashes",
    ).toBe("^u_-?\\d+(?:\\.\\d+)?$");
  });

  it("CONTROL: string-format checks keep the slash-wrapped pattern", () => {
    // These report `def.pattern.toString()`, i.e. WITH slashes — the opposite
    // convention, and the reason the shared source helper cannot serve both.
    const keys = ["code", "format", "message", "origin", "path", "pattern"];
    expectIssueFields(z.email(), "nope", "emailFormat", keys);
    expectIssueFields(z.string().regex(/^a+$/), "b", "regexFormat", keys);
    expect(
      (z.email().safeParse("nope") as { error?: { issues: { pattern?: unknown }[] } }).error
        ?.issues[0]?.pattern,
      "zod's format pattern is slash-wrapped",
    ).toMatch(/^\/.*\/$/);
  });

  it("discriminated-union no-match issue carries `options` in dispatch-map order", () => {
    const keys = ["code", "discriminator", "errors", "message", "note", "options", "path"];
    const du = z.discriminatedUnion("t", [
      z.object({ t: z.literal("a"), a: z.string() }),
      z.object({ t: z.literal("b"), b: z.number() }),
    ]);
    expectCompiled(du);
    expectIssueFields(du, { t: "z" }, "duNoMatch", keys);
    // `options` is the dispatch map's key order: option by option, each option's
    // values in ITS order, with an omittable discriminator's `undefined` (and a
    // nullable's `null`) trailing that option's own values — not a sorted or
    // deduplicated set.
    const ladder = z.discriminatedUnion("t", [
      z.object({ t: z.literal(["a", "c"]).optional() }),
      z.object({ t: z.enum(["b", "d"]).nullable() }),
    ]);
    expectCompiled(ladder);
    expectIssueFields(ladder, { t: "z" }, "duLadderNoMatch", keys);
    expect(
      (ladder.safeParse({ t: "z" }) as { error?: { issues: { options?: unknown }[] } }).error
        ?.issues[0]?.options,
      "zod's own options order",
    ).toStrictEqual(["a", "c", undefined, "b", "d", null]);
    // Same issue, unchanged, when the union sits under a container — the path
    // gains the parent segments and nothing else.
    expectIssueFields(z.object({ v: du }), { v: { t: "z" } }, "duNoMatchInObject", keys);
    expectIssueFields(z.array(du), [{ t: "z" }], "duNoMatchInArray", keys);
    // Enough cases to take the ordinal dispatch table rather than the string
    // switch; the no-match default is shared, but pin it on both.
    const wide = z.discriminatedUnion("t", [
      z.object({ t: z.literal("a"), a: z.string() }),
      z.object({ t: z.literal("b"), b: z.number() }),
      z.object({ t: z.literal("c"), c: z.number() }),
      z.object({ t: z.literal("d"), d: z.number() }),
    ]);
    expectCompiled(wide);
    expectIssueFields(wide, { t: "z" }, "duWideNoMatch", keys);
  });

  it("CONTROL: a plain union's invalid_union is unchanged", () => {
    // The other producer of `invalid_union`, which reports the per-option
    // errors rather than a discriminator note.
    expectIssueFields(z.union([z.string(), z.number()]), true, "plainUnion", [
      "code",
      "errors",
      "message",
      "path",
    ]);
  });
});

// ─── Paths nested inside an `invalid_union` ─────────────────────────────────
// $ZodUnion runs every option on a FRESH payload (`{ value, issues: [] }`), so
// an option's issues are numbered RELATIVE to the union's own position and
// handleUnionResults copies those relative paths into the `errors` groups
// unchanged. The compiled union used to walk its options at the union's
// ABSOLUTE path, which produced the right outer issue and leaked that path into
// every nested one: `z.object({ a: z.union([...]) })` reported the nested issues
// at `["a"]` where zod reports `[]`.
//
// The blind spot was structural, not accidental. `expectParity` compares only
// each issue's code, path and first message, and `expectIssueFields` above —
// which DOES descend into `errors` — only ever pinned a union at the root, where
// relative and absolute coincide. Every case here therefore asserts the whole
// tree, and at least one nested group has to be non-empty for it to mean
// anything.

describe("union option paths inside invalid_union", () => {
  /**
   * Every issue in the tree as `path: code@relativePath`, descending through
   * `invalid_union.errors` so a nested group's paths are compared, not just the
   * wrapper's. Keys are fully qualified (`0.errors[1].0`), so a mismatch names
   * the exact group rather than reporting two shuffled lists.
   */
  function issueTree(issues: readonly unknown[], prefix = ""): string[] {
    const lines: string[] = [];
    issues.forEach((raw, index) => {
      const issue = raw as { code?: string; path?: unknown[]; errors?: unknown };
      lines.push(`${prefix}${index}: ${issue.code}@${JSON.stringify(issue.path ?? [])}`);
      if (Array.isArray(issue.errors)) {
        issue.errors.forEach((group: unknown, groupIndex: number) => {
          if (Array.isArray(group)) {
            lines.push(...issueTree(group, `${prefix}${index}.errors[${groupIndex}].`));
          }
        });
      }
    });
    return lines;
  }

  /** {@link issueTree}'s sibling over `message` — same descent, same labels. */
  function messageTree(issues: readonly unknown[], prefix = ""): string[] {
    const lines: string[] = [];
    issues.forEach((raw, index) => {
      const issue = raw as { message?: string; errors?: unknown };
      lines.push(`${prefix}${index}: ${issue.message}`);
      if (Array.isArray(issue.errors)) {
        issue.errors.forEach((group: unknown, groupIndex: number) => {
          if (Array.isArray(group)) {
            lines.push(...messageTree(group, `${prefix}${index}.errors[${groupIndex}].`));
          }
        });
      }
    });
    return lines;
  }

  function rejectedIssues(result: unknown, label: string): unknown[] {
    const typed = result as { success: boolean; error?: { issues: unknown[] } };
    expect(typed.success, `${label} must reject for there to be a tree`).toBe(false);
    return typed.error?.issues ?? [];
  }

  /**
   * Zod's whole issue tree, then the same tree from both emit modes. `expected`
   * is passed in literally so the case documents what zod does — a silent
   * upstream change to the nesting fails here rather than being absorbed by a
   * self-referential comparison.
   */
  function expectTree(
    schema: ZodLikeSchema,
    input: unknown,
    name: string,
    expected: string[],
  ): void {
    expectCompiled(schema);
    expect(
      issueTree(rejectedIssues(schema.safeParse(input), `zod ${name}`)),
      `zod's tree for ${name}`,
    ).toStrictEqual(expected);
    const modes = [
      ["inline", compileLikeProduction(schema, name)],
      ["lean", compileLeanLikeProduction(schema, `${name}Lean`)],
    ] as const;
    for (const [mode, compiled] of modes) {
      expect(
        issueTree(rejectedIssues(compiled(input), `${mode} ${name}`)),
        `${mode} tree for ${name}`,
      ).toStrictEqual(expected);
    }
  }

  it("nested errors are relative to the union, not to the document", () => {
    expectTree(z.object({ a: z.union([z.string(), z.number()]) }), { a: true }, "unionInObject", [
      '0: invalid_union@["a"]',
      "0.errors[0].0: invalid_type@[]",
      "0.errors[1].0: invalid_type@[]",
    ]);
    expectTree(z.array(z.union([z.string(), z.number()])), [true], "unionInArray", [
      "0: invalid_union@[0]",
      "0.errors[0].0: invalid_type@[]",
      "0.errors[1].0: invalid_type@[]",
    ]);
    // Several segments deep, and through a loop variable — the union's path
    // expression names the enclosing element index, so it has to be read where
    // that binding is live.
    expectTree(
      z.object({ o: z.array(z.object({ u: z.union([z.string(), z.number()]) })) }),
      { o: [{ u: true }] },
      "unionDeep",
      [
        '0: invalid_union@["o",0,"u"]',
        "0.errors[0].0: invalid_type@[]",
        "0.errors[1].0: invalid_type@[]",
      ],
    );
  });

  it("an option's OWN sub-paths survive, rooted at the union", () => {
    // Object options give the nested issues real relative paths of their own,
    // so this separates "relative" from "empty" — the bug rendered these as
    // ["a","x"] / ["a","y"].
    expectTree(
      z.object({ a: z.union([z.object({ x: z.string() }), z.object({ y: z.number() })]) }),
      { a: {} },
      "unionOfObjects",
      [
        '0: invalid_union@["a"]',
        '0.errors[0].0: invalid_type@["x"]',
        '0.errors[1].0: invalid_type@["y"]',
      ],
    );
  });

  it("a union inside a union re-roots at the INNER union", () => {
    expectTree(
      z.object({ a: z.union([z.union([z.string(), z.number()]), z.boolean()]) }),
      { a: {} },
      "unionInUnion",
      [
        '0: invalid_union@["a"]',
        "0.errors[0].0: invalid_union@[]",
        "0.errors[0].0.errors[0].0: invalid_type@[]",
        "0.errors[0].0.errors[1].0: invalid_type@[]",
        "0.errors[1].0: invalid_type@[]",
      ],
    );
    // Same, with object options at both levels, so every level contributes a
    // segment and a dropped or doubled prefix cannot cancel out.
    expectTree(
      z.object({
        a: z.union([
          z.union([z.object({ x: z.string() }), z.object({ y: z.string() })]),
          z.boolean(),
        ]),
      }),
      { a: { x: 1 } },
      "unionInUnionOfObjects",
      [
        '0: invalid_union@["a"]',
        "0.errors[0].0: invalid_union@[]",
        '0.errors[0].0.errors[0].0: invalid_type@["x"]',
        '0.errors[0].0.errors[1].0: invalid_type@["y"]',
        "0.errors[1].0: invalid_type@[]",
      ],
    );
  });

  it("CONTROL: a union at the root is unchanged", () => {
    // Relative and absolute coincide at `[]`, so nothing may move — this is the
    // shape the old code got right, and the one the emitter must keep
    // prefix-free.
    expectTree(z.union([z.string(), z.number()]), true, "unionAtRoot", [
      "0: invalid_union@[]",
      "0.errors[0].0: invalid_type@[]",
      "0.errors[1].0: invalid_type@[]",
    ]);
  });

  it("the sole non-aborted option is surfaced at the ABSOLUTE path", () => {
    // handleUnionResults' shortcut: with exactly one non-aborted option it
    // returns THAT option's payload, whose issues are still relative, and the
    // parent prefixes them once. There is no `invalid_union` wrapper here at
    // all, so the union has to re-apply its own path — the half a relative walk
    // would otherwise break.
    expectTree(
      z.object({ a: z.union([z.string().min(5), z.number()]) }),
      { a: "ab" },
      "soleOptionInObject",
      ['0: too_small@["a"]'],
    );
    expectTree(z.array(z.union([z.string().min(5), z.number()])), ["ab"], "soleOptionInArray", [
      "0: too_small@[0]",
    ]);
    // The surfaced issue carries a relative path of its own, so the prefix has
    // to be spliced in front of it rather than replace it.
    expectTree(
      z.object({ a: z.union([z.object({ x: z.string().min(5) }), z.number()]) }),
      { a: { x: "ab" } },
      "soleOptionObjectOption",
      ['0: too_small@["a","x"]'],
    );
    // Two levels of shortcut: the inner union surfaces its sole option to the
    // outer union, which surfaces it again to the object.
    expectTree(
      z.object({ a: z.union([z.union([z.object({ x: z.string().min(5) }), z.number()])]) }),
      { a: { x: "ab" } },
      "soleOptionNested",
      ['0: too_small@["a","x"]'],
    );
    // And at the root, where the shortcut must add nothing.
    expectTree(z.union([z.string().min(5), z.number()]), "ab", "soleOptionAtRoot", [
      "0: too_small@[]",
    ]);
  });

  it("containers that prefix AFTER the fact still land at the right path", () => {
    // A map value is walked at `[]` and its issues are prefixed by the map
    // (util.prefixIssues / __zcPfx), so the union sits at a relative root and
    // must not prefix a second time.
    expectTree(
      z.map(z.string(), z.union([z.string(), z.number()])),
      new Map([["k", true]]),
      "unionInMapValue",
      [
        '0: invalid_union@["k"]',
        "0.errors[0].0: invalid_type@[]",
        "0.errors[1].0: invalid_type@[]",
      ],
    );
    expectTree(
      z.map(z.string(), z.union([z.string().min(5), z.number()])),
      new Map([["k", "ab"]]),
      "soleOptionInMapValue",
      ['0: too_small@["k"]'],
    );
    expectTree(
      z.record(z.string(), z.union([z.string(), z.number()])),
      { k: true },
      "unionInRecordValue",
      [
        '0: invalid_union@["k"]',
        "0.errors[0].0: invalid_type@[]",
        "0.errors[1].0: invalid_type@[]",
      ],
    );
  });

  it("messages are computed at the path the issue is reported under", () => {
    // The two branches finalize at different paths, so an error map reading
    // `issue.path` pins WHERE each is finalized: zod maps the `errors` groups
    // through finalizeIssue while they are still relative, while a surfaced
    // sole option is finalized at the top with its full path. Finalizing every
    // option eagerly, as the emitter used to, can only satisfy one of the two.
    const previous = z.config().customError;
    z.config({ customError: (issue) => `at ${JSON.stringify(issue.path ?? [])}` });
    try {
      const messages = (result: unknown, name: string): string[] =>
        messageTree(rejectedIssues(result, name));
      const cases: [string, ZodLikeSchema, unknown][] = [
        ["errorsBranchMsg", z.object({ a: z.union([z.string(), z.number()]) }), { a: true }],
        [
          "soleOptionBranchMsg",
          z.object({ a: z.union([z.string().min(5), z.number()]) }),
          { a: "ab" },
        ],
      ];
      for (const [name, schema, input] of cases) {
        const expected = messages(schema.safeParse(input), `zod ${name}`);
        // Non-vacuous by construction: every case has to produce at least one
        // message, or a helper that quietly returned nothing would "match".
        expect(expected.length, `zod produced messages for ${name}`).toBeGreaterThan(0);
        expect(
          messages(compileLikeProduction(schema, name)(input), name),
          `messages for ${name}`,
        ).toStrictEqual(expected);
      }
      // Spelled out, so the two branches are visibly different rather than just
      // equal to zod: relative inside `errors`, absolute once surfaced.
      const nested = z.object({ a: z.union([z.string(), z.number()]) }).safeParse({ a: true }) as {
        error?: { issues: { errors?: { message?: string }[][] }[] };
      };
      expect(nested.error?.issues[0]?.errors?.[0]?.[0]?.message).toBe("at []");
      const surfaced = z
        .object({ a: z.union([z.string().min(5), z.number()]) })
        .safeParse({ a: "ab" }) as { error?: { issues: { message?: string }[] } };
      expect(surfaced.error?.issues[0]?.message).toBe('at ["a"]');
    } finally {
      z.config({ customError: previous });
    }
  });
});

// ─── Finalized issues carry no `input` key at all ───────────────────────────
// Zod's `util.finalizeIssue` ends with `delete full.input` whenever the parse
// context has no `reportInput`, so a finalized issue does not merely read
// `undefined` at `.input` — it has no such own key. The compiled finalizers
// used to clear it by ASSIGNMENT, which leaves the key present: `"input" in
// issue` was true, `Object.keys(issue)` listed it, spreading an issue copied
// it, and `toStrictEqual` against zod's issue failed on a field both sides
// agreed was undefined.
//
// Every finalization site is covered, because they are separate code paths:
// the top-level loop in FAIL_CLASS_DECL, `__zcFz` (ZC_FZ_DECL) for issues
// nested inside an `invalid_key`/`invalid_element` wrapper and for an
// `invalid_union`'s per-option `errors`, and the hand-rolled loop in
// slowCatch that finalizes the array a `z.catch()` callback reads. `z.catch`'s
// OTHER view — the raw `ctx.issues` array — cannot match and is pinned in
// known-divergences.test.ts instead.

describe("finalized issues omit `input` entirely, as zod does", () => {
  /** Every issue reachable from `issue`, including nested wrapper payloads. */
  function flatten(issues: readonly unknown[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const raw of issues) {
      const issue = raw as Record<string, unknown>;
      out.push(issue);
      if (Array.isArray(issue["issues"])) out.push(...flatten(issue["issues"]));
      if (Array.isArray(issue["errors"])) {
        for (const group of issue["errors"] as unknown[]) {
          if (Array.isArray(group)) out.push(...flatten(group));
        }
      }
    }
    return out;
  }

  function issuesOf(result: unknown, label: string): Record<string, unknown>[] {
    const r = result as { success: boolean; error?: { issues: unknown[] } };
    expect(r.success, `${label} must reject`).toBe(false);
    const all = flatten(r.error?.issues ?? []);
    expect(all.length, `${label} produced issues`).toBeGreaterThan(0);
    return all;
  }

  const CASES: [name: string, schema: ZodLikeSchema, input: unknown, depth: number][] = [
    // Plain top-level failure — FAIL_CLASS_DECL's loop.
    ["plain", z.string(), 123, 1],
    // `invalid_key` wrapper + the key issue nested inside it — __zcFz. A record
    // key is a string, so zod takes handleRecordResult's non-property-key
    // branch only for the KEY schema's own issues.
    ["invalidKey", z.record(z.string().min(3), z.number()), { a: 1 }, 2],
    // `invalid_element` wrapper + its nested value issue — __zcFz again, via
    // the map branch a non-property-key key selects.
    ["invalidElement", z.map(z.boolean(), z.number().min(3)), new Map([[true, 1]]), 2],
    // `invalid_union` wrapper + one issue per option inside `errors` — __zcFz
    // on the option arrays, wrapper through the top-level loop.
    ["invalidUnion", z.object({ a: z.union([z.string(), z.number()]) }), { a: true }, 3],
  ];

  for (const [name, schema, input, depth] of CASES) {
    it(`${name}: no issue has an \`input\` key, and the key sets match zod`, () => {
      const zodIssues = issuesOf(schema.safeParse(input), `zod ${name}`);
      // The case really does reach the nesting it claims to, so a future shape
      // change cannot quietly reduce this to the top-level check.
      expect(zodIssues.length, `${name} reaches ${depth} issue(s)`).toBe(depth);
      for (const issue of zodIssues) {
        expect("input" in issue, `zod ${name}: zod itself must delete input`).toBe(false);
      }
      for (const [mode, compile] of [
        ["inline", compileLikeProduction],
        ["lean", compileLeanLikeProduction],
      ] as const) {
        const compiled = issuesOf(compile(schema, `noInput_${name}_${mode}`)(input), `${name}`);
        expect(compiled.length, `${mode} ${name}: same issue count`).toBe(zodIssues.length);
        compiled.forEach((issue, i) => {
          expect("input" in issue, `${mode} ${name}: issue ${i} has no input key`).toBe(false);
          expect(Object.keys(issue).sort(), `${mode} ${name}: issue ${i} key set`).toStrictEqual(
            Object.keys(zodIssues[i] as object).sort(),
          );
        });
      }
    });
  }

  it("z.catch()'s ctx.error.issues match zod's finalized key set", () => {
    // slowCatch finalizes its own array — it never reaches FAIL_CLASS_DECL,
    // since the catch value swallows the failure and the parse succeeds.
    const seen = (sink: (issues: unknown[]) => void) =>
      z
        .string()
        .min(4)
        .catch((ctx) => {
          sink(ctx.error.issues);
          return "fallback";
        });
    let zodIssues: unknown[] = [];
    let compiledIssues: unknown[] = [];
    const zodSchema = seen((issues) => {
      zodIssues = issues;
    });
    zodSchema.safeParse(123);
    compileLikeProduction(
      seen((issues) => {
        compiledIssues = issues;
      }),
      "noInputCatch",
    )(123);

    expect(zodIssues, "zod ran the catch callback").toHaveLength(1);
    expect(compiledIssues, "compiled ran the catch callback").toHaveLength(1);
    const zodIssue = zodIssues[0] as Record<string, unknown>;
    const compiledIssue = compiledIssues[0] as Record<string, unknown>;
    expect("input" in zodIssue, "zod's ctx.error.issues drop input").toBe(false);
    expect("input" in compiledIssue, "compiled ctx.error.issues drop input").toBe(false);
    expect(Object.keys(compiledIssue).sort()).toStrictEqual(Object.keys(zodIssue).sort());
  });
});

// ─── Records validate only PLAIN objects ────────────────────────────────────
// `$ZodRecord` gates on `util.isPlainObject`, which is strictly narrower than
// the `util.isObject` (`typeof "object"`, not null, not an array) that
// `$ZodObject` uses. Sharing the object guard was a validation hole in the one
// direction that matters: compiled output ACCEPTED a Date, a Map, a RegExp, an
// Error, a File and any class instance, none of which has own enumerable string
// keys for the value schema to catch, while zod rejects all of them.

describe("records accept only plain objects, as $ZodRecord does", () => {
  const NON_PLAIN: [string, () => unknown][] = [
    ["Date", () => new Date(0)],
    ["Map", () => new Map([["a", 1]])],
    ["Set", () => new Set(["a"])],
    ["RegExp", () => /re/],
    ["Error", () => new Error("boom")],
    ["class instance", () => new (class Foo {})()],
    ["File", () => new File(["x"], "a.txt")],
    ["own constructor that is a function", () => ({ constructor: class Bar {} })],
  ];
  const PLAIN: [string, () => unknown][] = [
    ["plain literal", () => ({ a: "x" })],
    ["null prototype", () => Object.create(null) as object],
    ["inherits from a plain object", () => Object.create({ inherited: 1 }) as object],
    ["own constructor that is NOT a function", () => ({ constructor: 1 })],
  ];
  const inputs = [...NON_PLAIN, ...PLAIN].map(([, make]) => make());

  it("rejects every non-plain object and keeps accepting the plain ones", () => {
    expectParity(z.record(z.string(), z.unknown()), inputs);
    expectParity(z.record(z.string(), z.string()), inputs);
    expectParity(z.looseRecord(z.string(), z.unknown()), inputs);
    expectParity(z.partialRecord(z.string(), z.unknown()), inputs);
  });

  it("holds wherever the record is nested", () => {
    expectParity(
      z.object({ r: z.record(z.string(), z.unknown()) }),
      inputs.map((value) => ({ r: value })),
    );
    expectParity(z.array(z.record(z.string(), z.unknown())), [inputs]);
    expectParity(z.union([z.record(z.string(), z.unknown()), z.number()]), inputs);
    expectParity(z.json(), inputs);
  });

  it("holds on the rebuilding (mutating-value) path too", () =>
    expectParity(z.record(z.string(), z.string().trim()), inputs));

  it("CONTROL: z.object() keeps the LOOSER isObject guard", () =>
    expectParity(z.object({}), inputs));
});

// ─── `__proto__` is not a record key ────────────────────────────────────────
// zod's record walk opens with `if (key === "__proto__") continue`, so an own
// `__proto__` data property — which `JSON.parse` creates, and which is how
// prototype-pollution payloads arrive — is neither key-validated nor
// value-validated. The compiled walk validated it and reported issues zod never
// raises. An object's catchall pass skips it the same way.

describe("records skip an own `__proto__` key, as zod does", () => {
  // Inputs are chosen so BOTH sides reject: on success the comparison would be
  // dominated by the record's by-reference output, which keeps the `__proto__`
  // key zod's fresh object drops (pinned in known-divergences.test.ts). What is
  // asserted here is the ISSUE LIST — that the skipped key contributes none.
  const withProto = (a: unknown) =>
    JSON.parse(`{"a":${JSON.stringify(a)},"__proto__":{"polluted":true}}`) as unknown;
  const badProtoValue = () => JSON.parse('{"a":"bad","__proto__":"not-a-number"}') as unknown;

  it("raises no issue for the key itself", () =>
    expectParity(z.record(z.string().min(20), z.unknown()), [withProto("x")]));

  it("raises no issue for its VALUE, even one the value schema rejects", () =>
    expectParity(z.record(z.string(), z.number()), [badProtoValue()]));

  it("holds on the rebuilding path", () =>
    expectParity(z.record(z.string(), z.string().trim().min(20)), [badProtoValue()]));

  it("an object catchall skips it the same way", () =>
    expectParity(z.object({ a: z.number() }).catchall(z.number()), [badProtoValue()]));
});

// ─── Tuple `optStart` comes from zod's `optin`, not from the IR shape ───────
// $ZodTuple computes the start of its omittable tail from each item's
// `_zod.optin`, SKIPS those items entirely when the input is shorter, and moves
// the under-length `too_small` threshold with it. Inferring that from the
// extracted IR recognised only `optional` and `default`, so every other
// optional-in shape — all of which extract to something else — lost its
// omittable tail.

describe("tuple items that zod treats as omittable", () => {
  const OPTIONAL_IN: [string, () => z.ZodType][] = [
    ["optional", () => z.string().optional()],
    ["exactOptional", () => z.exactOptional(z.string())],
    ["default", () => z.string().default("d")],
    ["prefault", () => z.string().prefault("d")],
    ["catch", () => z.string().catch("c")],
    ["nullable over optional", () => z.string().optional().nullable()],
    ["readonly over optional", () => z.string().optional().readonly()],
    ["lazy over optional", () => z.lazy(() => z.string().optional())],
    ["union with an optional option", () => z.union([z.string().optional(), z.number()])],
    ["nonoptional over optional", () => z.string().optional().nonoptional()],
    ["pipe from an optional", () => z.string().optional().pipe(z.string().optional())],
    ["prefault whose inner check fails", () => z.string().min(5).prefault("ab")],
    ["default whose inner check fails", () => z.string().min(5).default("ab")],
  ];

  for (const [label, make] of OPTIONAL_IN) {
    it(`${label}: absent trailing item is skipped, not validated`, () => {
      expectParity(z.tuple([make()]), [[], [undefined], ["s"], ["abcdef"], [1]]);
      expectParity(z.tuple([make()]).rest(z.number()), [[], ["s"], ["s", 1]]);
    });

    it(`${label}: shifts the under-length threshold when it trails a required item`, () =>
      expectParity(z.tuple([z.string(), make()]), [[], ["a"], ["a", undefined], ["a", "s"]]));

    it(`${label}: is still required when a required item follows it`, () =>
      expectParity(z.tuple([make(), z.string()]), [[], ["a"], ["a", "b"]]));
  }

  // Accepting `undefined` is not the same as permitting absence: these sit on
  // the bottom rung of `optin`, so a short input is `too_small` and only an
  // explicit `undefined` reaches the item.
  it("z.undefined() and z.any() are required-in", () => {
    for (const make of [() => z.undefined(), () => z.any(), () => z.string().or(z.undefined())]) {
      expectParity(z.tuple([make()]), [[], [undefined], ["s"]]);
      expectParity(z.tuple([z.string(), make()]), [[], ["a"], ["a", undefined]]);
    }
  });
});

// Without a rest element a required slot past the end is `too_small` before
// any item runs. With one there is no length gate: zod RUNS the item on
// `undefined` and `handleTupleResults` writes its result back, so the output
// is longer than the input whenever that item accepts `undefined`.
describe("a required slot past the end", () => {
  it("is too_small without a rest element, whatever the item accepts", () => {
    expectParity(z.tuple([z.any(), z.any()]), [["x"], ["x", "y"], []]);
    expectParity(z.tuple([z.unknown(), z.unknown()]), [["x"], []]);
    expectParity(z.tuple([z.any(), z.string().default("d")]), [[], ["x"], ["x", "y"]]);
  });

  it("lands as an own undefined with a rest element, where no length gate hides it", () =>
    expectParity(z.tuple([z.any(), z.any()]).rest(z.number()), [[], ["x"], ["x", "y", 1]]));

  it("CONTROL: a required slot that REJECTS undefined fails instead of padding", () =>
    expectParity(z.tuple([z.string(), z.string()]), [["x"], []]));
});

// ─── Absent omittable slots: handleTupleResults ─────────────────────────────
// Every item runs, and the walk over the results decides the output's length:
// at or past `optoutStart` an absent "optional"-rung slot ends the output and a
// failed "defaulted" one does the same with its issues dropped; below it the
// result is written back so a later required-out slot keeps its index; and a
// trailing run of `undefined`s from absent optional-out slots is trimmed.

describe("absent tuple slots shape the output as handleTupleResults does", () => {
  it("below optoutStart the slot is written back, issues and all", () => {
    expectParity(z.tuple([z.string(), z.string().optional(), z.string().catch("c")]), [
      ["a"],
      ["a", undefined],
      ["a", "b"],
      ["a", 1],
    ]);
    expectParity(z.tuple([z.string(), z.string().optional().pipe(z.string())]), [
      ["a"],
      ["a", "b"],
    ]);
    expectParity(z.tuple([z.string(), z.string().min(5).prefault("ab")]), [["a"], ["a", "abcdef"]]);
  });

  it("at or past optoutStart a defaulted slot keeps its value and a failed one ends the output", () => {
    const failing = () => z.string().min(5).prefault("ab").optional();
    expectParity(z.tuple([z.string(), z.string().default("d").optional()]), [["a"], ["a", "b"]]);
    expectParity(z.tuple([z.string(), failing()]), [["a"], ["a", "abcdef"], ["a", "ab"]]);
    expectParity(z.tuple([z.string(), failing(), z.string().default("e")]), [["a"], ["a", "x"]]);
    expectParity(z.tuple([z.string().optional(), z.exactOptional(z.string())]), [[], ["a"]]);
    expectParity(z.tuple([z.string().default("d").optional(), z.exactOptional(z.string())]), [[]]);
  });

  it("a trailing undefined from an absent optional-out slot is trimmed, an explicit one kept", () => {
    const opts = z.tuple([z.string(), z.string().optional(), z.string().optional()]);
    expectParity(opts, [["a"], ["a", undefined], ["a", undefined, undefined], ["a", "b"]]);
    expectParity(z.tuple([z.string().pipe(z.string().optional())]).rest(z.number()), [
      [],
      [undefined],
    ]);
  });

  it("too_big no longer skips the items: their issues follow it", () => {
    expectParity(z.tuple([z.string()]), [
      [1, 2],
      ["a", 2],
    ]);
    expectParity(z.union([z.tuple([z.string()]), z.number()]), [[1, 2]]);
  });
});

// ─── `.optional()` over a "defaulted" inner ─────────────────────────────────
// `$ZodOptional.parse` short-circuits `undefined` unless `innerType._zod.optin`
// is `"defaulted"`: then it RUNS the inner on a payload of its own (so a
// `.default()`/`.prefault()` underneath fires) and, if that failed, yields
// `undefined` with the failure dropped. The compiled short-circuit models the
// other branch, and the `.default()` case explicitly; everything else delegates.

describe("optional() wrapping a schema that consumes undefined itself", () => {
  it("prefault fires through the optional", () =>
    expectParity(z.string().prefault("d").optional(), [undefined, "x", 1]));

  it("a prefault whose value fails its own checks yields undefined, not the failure", () =>
    expectParity(z.string().min(5).prefault("ab").optional(), [undefined, "abcdef", "ab"]));

  it("default fires through the optional, including under a nullable", () => {
    expectParity(z.string().default("d").optional(), [undefined, "x", 1]);
    expectParity(z.string().default("d").nullable().optional(), [undefined, null, "x"]);
    expectParity(z.string().default("d").optional().optional(), [undefined, "x"]);
  });

  it("a union option that consumes undefined fires through the optional", () =>
    expectParity(z.union([z.string().default("d"), z.number()]).optional(), [undefined, "x", 1]));

  it("shapes that only pass undefined through still short-circuit", () => {
    expectParity(z.string().optional().optional(), [undefined, "x", 1]);
    expectParity(z.exactOptional(z.string()).optional(), [undefined, "x", 1]);
    expectParity(z.undefined().optional(), [undefined, "x"]);
    expectParity(z.string().catch("c").optional(), [undefined, "x", 1]);
    expectParity(z.string().optional().nullable().optional(), [undefined, null, "x", 1]);
  });
});

// ─── Absent keys follow the `optin` ladder, not the IR shape ────────────────
// `handlePropertyResult` reads the schema's `optin`/`optout`: an absent key on
// the "optional" rung contributes nothing, on the "defaulted" rung runs with a
// failure swallowed, and on the bottom rung is an `invalid_type` of its own
// (`expected: "nonoptional"`) whenever the schema accepted the `undefined` it
// saw. Keying any of that off "the property extracted to a fallback" was one
// wrapper too narrow.

const OBJECT_VARIANTS = (make: () => z.ZodType): z.ZodType[] => [
  z.object({ a: make() }),
  z.object({ a: make(), b: z.number() }),
  z.strictObject({ a: make(), b: z.number() }),
  z.looseObject({ a: make(), b: z.number() }),
  z.object({ a: make() }).catchall(z.number()),
];

describe("optional-out properties whose key is absent", () => {
  const OPTOUT: [string, () => z.ZodType][] = [
    ["exactOptional", () => z.exactOptional(z.string())],
    ["nullable over exactOptional", () => z.exactOptional(z.string()).nullable()],
    ["readonly over exactOptional", () => z.exactOptional(z.string()).readonly()],
    ["nullable over optional", () => z.string().min(5).optional().nullable()],
    ["pipe between optionals", () => z.string().optional().pipe(z.string().min(5).optional())],
  ];
  for (const [label, make] of OPTOUT) {
    it(`${label}: absent key raises nothing, explicit undefined still does`, () => {
      const inputs = [{}, { a: undefined }, { a: "abcdef" }, { a: 1 }];
      for (const schema of OBJECT_VARIANTS(make)) expectParity(schema, inputs);
    });
  }

  it("a defaulted property runs for an absent key and swallows its own failure", () => {
    const inputs = [{}, { a: undefined }, { a: "abcdef" }, { a: "ab" }];
    for (const schema of OBJECT_VARIANTS(() => z.string().min(5).prefault("ab").optional())) {
      expectParity(schema, inputs);
    }
    for (const schema of OBJECT_VARIANTS(() => z.string().prefault("abcdef").optional())) {
      expectParity(schema, inputs);
    }
  });
});

describe("required properties whose key is absent", () => {
  const REQUIRED: [string, () => z.ZodType][] = [
    ["z.undefined()", () => z.undefined()],
    ["z.any()", () => z.any()],
    ["z.unknown()", () => z.unknown()],
    ["union with an undefined option", () => z.string().or(z.undefined())],
    ["nullable over any", () => z.any().nullable()],
    ["nonoptional over optional", () => z.string().optional().nonoptional()],
    ["pipe into an optional", () => z.any().pipe(z.string().optional())],
    // A delegating property that ACCEPTS `undefined` and writes its result
    // back. Where the object needs no clone the write target IS the input, so
    // running the property created the key the absent-key guard then tested —
    // and the issue was never raised. The fast path still rejected on
    // `"a" in x`, so `safeParse` failed with an empty `issues` array.
    ["z.custom()", () => z.custom()],
    ["z.custom() over a truthy predicate", () => z.custom(() => true)],
  ];
  for (const [label, make] of REQUIRED) {
    it(`${label}: absent key is nonoptional, explicit undefined is the schema's call`, () => {
      const inputs = [{}, { a: undefined }, { a: "abcdef" }, { a: 1 }];
      for (const schema of OBJECT_VARIANTS(make)) expectParity(schema, inputs);
    });
  }

  it("the absence aborts, so an object-level refine does not run", () =>
    expectParity(
      z.object({ a: z.any() }).refine(() => false, "never runs"),
      [{}, { a: 1 }],
    ));

  /**
   * zod's `handlePropertyResult` RETURNS on the absent-required-key branch
   * without assigning, so nothing the property made of `undefined` reaches the
   * output — or the input. The compiled walk writes a delegating property's
   * result straight back through the slot it read from, which on a
   * clone-free object is the caller's own object, so the drop has to be
   * explicit. Checked on the input rather than the output because the parse
   * always fails here and the output is discarded.
   */
  it("a delegating required property leaves no key on the caller's input", () => {
    for (const schema of OBJECT_VARIANTS(() => z.custom())) {
      const compiled = compileLikeProduction(schema);
      const zodInput: Record<string, unknown> = { b: 1 };
      const compiledInput: Record<string, unknown> = { b: 1 };
      // The error is built lazily, and it is the slow walk that writes back —
      // so the issues have to be read before the input is inspected.
      void schema.safeParse(zodInput).error?.issues;
      void compiled(compiledInput).error?.issues;
      expect(Object.keys(compiledInput)).toStrictEqual(Object.keys(zodInput));
    }
  });

  it("CONTROL: a property that rejects undefined reports its own issue instead", () =>
    expectParity(z.object({ a: z.string(), b: z.string().pipe(z.string().optional()) }), [
      {},
      { a: "x" },
    ]));
});

// ─── Length/size checks run even after the type check failed ────────────────
// `runChecks` consults a check's `when` predicate INSTEAD of the abort flag, and
// the length/size families install one (`!nullish(value) && value.length/size
// !== undefined`). So they fire on any input carrying that property, of any
// type, and report an `origin` derived from the INPUT.

describe("length and size checks reached through their `when` predicate", () => {
  it("string length checks fire on a non-string that has a length", () => {
    expectParity(z.string().min(2), [[], [1, 2, 3], "a", { length: 5 }, 1, null, undefined]);
    expectParity(z.string().max(2), [[1, 2, 3], [], "abc"]);
    expectParity(z.string().length(2), [[1, 2, 3], [], "abc"]);
    expectParity(z.string().min(2).max(3), [[], [1, 2, 3, 4]]);
  });

  it("array length checks fire on a string", () => {
    expectParity(z.array(z.string()).min(3), ["ab", "abcd", 1, []]);
    expectParity(z.array(z.string()).max(1), ["ab", []]);
    expectParity(z.array(z.string()).length(2), ["a", "abc", ["a", "b"]]);
  });

  it("set size checks fire on a Map, and file size checks on a Set", () => {
    expectParity(z.set(z.string()).min(2), [new Map([["a", 1]]), new Map(), "ab", new Set(["a"])]);
    expectParity(z.set(z.string()).max(1), [
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
      new Set(),
    ]);
    expectParity(z.set(z.string()).size(2), [new Map(), new Set(["a", "b"])]);
    expectParity(z.file().min(2), [new Set(["a"]), new Set(), new Map()]);
  });

  it("carries the custom message and nests at the right path", () => {
    expectParity(z.string().min(2, "at least two"), [[]]);
    expectParity(z.object({ a: z.string().min(2) }), [{ a: [] }]);
    expectParity(z.array(z.string().min(2)), [[[]]]);
  });

  it("CONTROL: checks without a `when` stay gated by the abort", () => {
    expectParity(z.string().regex(/^a/), [[], 1]);
    expectParity(z.number().gt(2), ["x", []]);
    expectParity(z.string().includes("q"), [[]]);
  });
});

// ─── A tuple's length issue aborts its union option ─────────────────────────
// zod prunes union options with `util.aborted` — "any issue with `continue !==
// true`" — and a tuple's length issue is pushed by the NODE, so it carries no
// `continue` and aborts, unlike the identically-coded issue from a
// `.min()`/`.max()` CHECK.

describe("union pruning treats a tuple's length issue as aborting", () => {
  it("wraps both options instead of surfacing the tuple's own issue", () => {
    expectParity(z.union([z.tuple([z.string(), z.string()]), z.number()]), [
      [],
      ["a"],
      ["a", "b", "c"],
      1,
    ]);
    expectParity(
      z.union([
        z.tuple([z.bigint(), z.record(z.string(), z.string())]),
        z.record(z.string(), z.tuple([z.string(), z.date()])),
      ]),
      [[], [1n]],
    );
  });

  it("holds when the tuple is nested inside the option", () =>
    expectParity(z.union([z.object({ t: z.tuple([z.string(), z.string()]) }), z.number()]), [
      { t: [] },
      { t: ["a", "b"] },
    ]));

  it("also gates a following refine on the same node", () =>
    expectParity(
      z.tuple([z.string(), z.string()]).refine(() => false, "never runs"),
      [[], ["a", "b"]],
    ));

  it("CONTROL: an array's min() issue is continuable and does NOT abort", () =>
    expectParity(z.union([z.array(z.string()).min(2), z.number()]), [[], ["a"], 1]));
});

// ─── A union option that rewrites forbids the by-reference shortcut ─────────
// The fast form of a plain union is an `||` chain, which reports that SOME
// option accepts the input; zod returns the value produced by the FIRST option
// that succeeds. A `.catch()` option can never fail, so it claims every input.

describe("unions whose options rewrite the value", () => {
  it("a catch option claims every input", () => {
    expectParity(z.union([z.string().catch("c"), z.number()]), [1, "x", true, null, {}]);
    expectParity(z.union([z.string().catch("c"), z.literal(999), z.boolean(), z.null()]), [
      999,
      1,
      true,
      null,
    ]);
    expectParity(z.object({ u: z.union([z.string().catch("c"), z.number()]) }), [{ u: 1 }]);
    expectParity(z.array(z.union([z.string().catch("c"), z.number()])), [[1], ["x"], [1, "x"]]);
  });

  it("an earlier rewriting option wins over a later exact match", () => {
    expectParity(z.union([z.string().trim(), z.string()]), [" x ", "x"]);
    expectParity(z.union([z.coerce.number(), z.string()]), ["5", "x"]);
  });

  it("CONTROL: a union of pure validators still takes the fast path", () =>
    expectParity(z.union([z.string(), z.number()]), ["x", 1, true]));
});

/**
 * zod 4.5 added SYMBOL keys to `$ZodObject`'s shape walk — `normalizeDef` now
 * builds `allKeys` as `[...Object.keys(shape), ...getOwnPropertySymbols(shape)]`
 * — so a symbol-keyed property is validated, reported absent, and copied to the
 * output exactly like a string-keyed one. The IR is keyed by string throughout,
 * so such a shape is delegated rather than silently dropping the property.
 */
describe("symbol-keyed shape properties", () => {
  const SYM = Symbol.for("zod-compiler-test-symbol");
  it("a symbol-keyed property is delegated, not ignored", () => {
    const schema = z.object({ [SYM]: z.string(), a: z.number() });
    expectParity(schema, [{ a: 1 }, { a: 1, [SYM]: "s" }, { a: 1, [SYM]: 2 }, {}]);
  });
  it("a symbol-only shape is delegated too", () =>
    expectParity(z.object({ [SYM]: z.string() }), [{}, { [SYM]: "s" }, { [SYM]: 2 }]));
  it("string-keyed shapes still compile", () =>
    expectCompiled(z.object({ a: z.number(), b: z.string() })));
});

/**
 * zod 4.5's `handleIntersectionResults` reconciles record `invalid_key` issues
 * the same way it always reconciled `unrecognized_keys`: `collect` takes any
 * root-level `unrecognized_keys` AND any record `invalid_key` one segment deep,
 * and re-reports only the keys BOTH sides rejected. A sequential two-pass run
 * cannot pair those key sets, so a record that can raise either issue has to
 * delegate — including the partial record over a finite key set, which this
 * release started compiling.
 */
describe("intersections of records reconcile key issues", () => {
  it("partial records over disjoint enum key sets", () =>
    expectParity(
      z.intersection(
        z.partialRecord(z.enum(["a"]), z.number()),
        z.partialRecord(z.enum(["b"]), z.number()),
      ),
      [{}, { a: 1 }, { b: 2 }, { a: 1, b: 2 }, { c: 3 }],
    ));
  it("records over disjoint constrained key schemas", () =>
    expectParity(
      z.intersection(
        z.record(z.string().regex(/^a/), z.number()),
        z.record(z.string().regex(/^b/), z.number()),
      ),
      [{}, { a1: 1 }, { b1: 2 }, { a1: 1, b1: 2 }, { c1: 3 }],
    ));
  // CONTROL: an unconstrained string key schema accepts every own enumerable
  // string key, so it raises neither reconciled issue and must not be delegated
  // by the widened gate.
  it("an unconstrained string key schema still compiles", () =>
    expectCompiled(
      z.intersection(z.record(z.string(), z.number()), z.record(z.string(), z.number())),
    ));
});
