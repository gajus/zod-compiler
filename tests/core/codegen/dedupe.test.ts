import { describe, expect, it } from "vite-plus/test";
import { ZodRealError, z } from "zod";
import { FAIL_CLASS_DECL, FIN_DECL, FIN_DEFERRED_DECL } from "#src/core/iife.js";
import { compileSchemas, type CompiledSchemaInfo } from "#src/core/pipeline.js";

const __zcFin = new Function(
  "__zcMsg",
  "__zcZodError",
  `${FAIL_CLASS_DECL}${FIN_DECL}; return __zcFin;`,
)(undefined, ZodRealError);
const __zcFinD = new Function(
  "__zcMsg",
  "__zcZodError",
  `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}; return __zcFinD;`,
)(undefined, ZodRealError);

type Runnable = (input: unknown) => {
  success: boolean;
  data?: unknown;
  error?: { issues: { code: string; path: (string | number)[] }[] };
};

/**
 * Build a runnable validator from a compiled schema + its file's shared block.
 * Mirrors production scope nesting: the shared block sits at the outer (module)
 * scope while each schema's own preamble lives inside an IIFE — so a per-schema
 * `const` (e.g. a record's `__zcHop`) never collides with the shared block's.
 */
function build(info: CompiledSchemaInfo, sharedCode: string): Runnable {
  const fnName = /function (safeParse_\w+)/.exec(info.codegenResult.functionDef)?.[1];
  if (fnName === undefined) throw new Error("no safeParse function in generated code");
  const src = `${sharedCode}\nreturn (function(){\n${info.codegenResult.code}\n${info.codegenResult.functionDef}\nreturn ${fnName};\n})();`;
  return new Function("__zcMsg", "__zcZodError", "__zcFin", "__zcFinD", src)(
    undefined,
    ZodRealError,
    __zcFin,
    __zcFinD,
  ) as Runnable;
}

/** Find a compiled schema by export name (throws if absent). */
function pick(schemas: CompiledSchemaInfo[], name: string): CompiledSchemaInfo {
  const found = schemas.find((s) => s.exportName === name);
  if (found === undefined) throw new Error(`no compiled schema named ${name}`);
  return found;
}

/** Issue shape for parity comparison (code + path; messages depend on locale). */
function shape(r: { success: boolean; error?: { issues: { code: string; path: unknown }[] } }) {
  return r.success
    ? "ok"
    : JSON.stringify(r.error?.issues.map((i) => ({ code: i.code, path: i.path })));
}

function refs(info: CompiledSchemaInfo): string[] {
  return [...new Set([...source(info).matchAll(/__zcSw_\d+/g)].map((m) => m[0]))];
}

/** A compiled schema's full generated text (preamble + validator). */
function source(info: CompiledSchemaInfo): string {
  return info.codegenResult.code + info.codegenResult.functionDef;
}

describe("schema dedupe", () => {
  it("emits one shared walk and references it from every occurrence", () => {
    const Address = z.strictObject({
      street: z.string(),
      city: z.string(),
      zip: z.string().min(3),
    });
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "Address", schema: Address },
        {
          exportName: "User",
          schema: z.strictObject({ name: z.string(), home: Address, work: Address }),
        },
        { exportName: "Company", schema: z.strictObject({ legalName: z.string(), hq: Address }) },
      ],
      { mode: "inline" },
    );

    // Exactly one shared function, referenced by all three exports.
    expect((shared.code.match(/function __zcSw_\d+/g) ?? []).length).toBe(1);
    for (const s of schemas) {
      expect(refs(s)).toContain("__zcSw_0");
    }
  });

  it("validates byte-identically to zod through the shared walk (valid + nested errors)", () => {
    const Address = z.strictObject({
      street: z.string(),
      city: z.string(),
      zip: z.string().min(3),
    });
    const User = z.strictObject({ name: z.string(), home: Address, work: Address });
    const Company = z.strictObject({ legalName: z.string(), hq: Address });
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "Address", schema: Address },
        { exportName: "User", schema: User },
        { exportName: "Company", schema: Company },
      ],
      { mode: "inline" },
    );
    const get = (name: string) => build(pick(schemas, name), shared.code);

    const checks: [string, z.ZodType, unknown][] = [
      ["Address", Address, { street: "1 A St", city: "Town", zip: "123" }],
      ["Address", Address, { street: "x", city: "y", zip: "1" }],
      ["Address", Address, "nope"],
      [
        "User",
        User,
        {
          name: "Jo",
          home: { street: "a", city: "b", zip: "123" },
          work: { street: "c", city: "d", zip: "456" },
        },
      ],
      // nested error: home.zip too small AND work not an object — distinct paths through the same shared walk
      ["User", User, { name: "Jo", home: { street: "a", city: "b", zip: "1" }, work: 5 }],
      ["Company", Company, { legalName: "Co", hq: { street: "a", city: "b", zip: "x" } }],
    ];
    for (const [name, zod, input] of checks) {
      const compiled = get(name)(input);
      const native = zod.safeParse(input);
      expect(compiled.success).toBe(native.success);
      expect(shape(compiled)).toBe(shape(native));
    }
  });

  it("is a no-op when no shape repeats", () => {
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A", schema: z.strictObject({ a: z.string(), b: z.number() }) },
        { exportName: "B", schema: z.strictObject({ c: z.boolean(), d: z.string().email() }) },
      ],
      { mode: "inline" },
    );
    expect(shared.code).toBe("");
    for (const s of schemas) expect(refs(s)).toHaveLength(0);
  });

  it("does not share trivial shapes below the weight threshold", () => {
    // A bare repeated string appears many times but is too small to share.
    const { shared } = compileSchemas(
      [
        { exportName: "A", schema: z.strictObject({ a: z.string(), b: z.string() }) },
        { exportName: "B", schema: z.strictObject({ c: z.string(), d: z.string() }) },
      ],
      { mode: "inline" },
    );
    expect(shared.code).toBe("");
  });

  it("delegates a root walk when the root shape is itself shared", () => {
    const Row = z.strictObject({ id: z.number().int(), name: z.string(), active: z.boolean() });
    const { schemas } = compileSchemas(
      [
        { exportName: "Row", schema: Row },
        { exportName: "Wrapper", schema: z.strictObject({ row: Row, count: z.number() }) },
      ],
      { mode: "inline" },
    );
    // Row's own slow walk should be the delegate call, not a re-inlined object walk.
    const row = pick(schemas, "Row");
    expect(refs(row)).toHaveLength(1);
    // The deferred walk body should contain the shared call and not push object issues itself.
    expect(row.codegenResult.code).toContain("__zcSw_0(");
  });

  it("keeps the fast path fully inlined (never shares the hot path)", () => {
    const Address = z.strictObject({ street: z.string(), city: z.string(), zip: z.string() });
    const { schemas } = compileSchemas(
      [
        { exportName: "User", schema: z.strictObject({ a: Address, b: Address }) },
        { exportName: "Co", schema: z.strictObject({ hq: Address }) },
      ],
      { mode: "inline" },
    );
    const user = pick(schemas, "User");
    // The hosted fast-check function inlines the nested Address check — no shared call.
    const fastFn = /function __fc_\d+\(input\)\{return ([^;]*);\}/.exec(user.codegenResult.code);
    const fastBody = fastFn?.[1] ?? "";
    expect(fastBody).not.toBe("");
    expect(fastBody).not.toContain("__zcSw");
    expect(fastBody).toContain('input["a"]["street"]');
  });

  it("shares a stripping z.object() — the walk returns its rebuild", () => {
    // A genuine z.object() strips, so its walk PRODUCES a rebuilt object. The
    // shared body returns that value and the call site assigns it, so the shape
    // shares like any other. It did not always: while shared walks returned
    // nothing, this exclusion silently covered essentially every real schema,
    // since z.object() is what people write.
    const Stripping = z.object({ a: z.string(), b: z.string(), c: z.string() });
    const { schemas: stripped, shared: strippedShared } = compileSchemas(
      [
        { exportName: "S1", schema: z.strictObject({ x: Stripping, y: Stripping }) },
        { exportName: "S2", schema: z.strictObject({ z: Stripping }) },
      ],
      { mode: "inline" },
    );
    expect(strippedShared.code).toContain("__zcSw_0");
    // The rebuild is delivered through the return value, not a write-back.
    expect(strippedShared.code).toMatch(/return input;\s*\n?}/);
    expect(refs(pick(stripped, "S1"))).toContain("__zcSw_0");
    expect(refs(pick(stripped, "S2"))).toContain("__zcSw_0");
    // Call sites assign what the shared walk returned.
    expect(source(pick(stripped, "S1"))).toMatch(/=__zcSw_0\(/);

    // Same shape declared strict instead: shareable again.
    const PassThrough = z.strictObject({ a: z.string(), b: z.string(), c: z.string() });
    const { shared: passShared } = compileSchemas(
      [
        { exportName: "P1", schema: z.strictObject({ x: PassThrough, y: PassThrough }) },
        { exportName: "P2", schema: z.strictObject({ z: PassThrough }) },
      ],
      { mode: "inline" },
    );
    expect(passShared.code).toContain("__zcSw_0");
  });

  it("shares into a mutation-bearing root's deferred error walk", () => {
    const Shape = z.strictObject({ a: z.string(), b: z.string(), c: z.string() });
    const { schemas } = compileSchemas(
      [
        { exportName: "R1", schema: z.strictObject({ x: Shape, y: Shape }) },
        { exportName: "R2", schema: z.strictObject({ z: Shape }) },
        // Mutation root (coerce): the build pass handles valid input; its cold
        // error walk may still share the repeated strict shape.
        { exportName: "M", schema: z.strictObject({ w: Shape, n: z.coerce.number() }) },
      ],
      { mode: "inline" },
    );
    expect(refs(pick(schemas, "R1"))).toContain("__zcSw_0");
    expect(refs(pick(schemas, "R2"))).toContain("__zcSw_0");
    expect(refs(pick(schemas, "M"))).toContain("__zcSw_0");
  });

  it("never shares a shape that resolves through the per-export __rf array", () => {
    // `__rf` is declared inside each export's IIFE; a module-scope shared body
    // referencing it would be unbound. Zero-capture callbacks are fine — they
    // are hosted from source text into the shared block's own preamble.
    const captured = { min: 3 };
    for (const inner of [
      z.string().default("d"),
      z.number().catch(0),
      z.string().refine((v) => v.length > captured.min),
      z.string().transform((v) => v + captured.min),
      // Zero-capture predicate, but `.refine(fn, { params })` still parks the
      // params object in `__rf` — the issue reads it back from there.
      z.string().refine((v) => v.length > 3, { params: { code: "E_SHORT" } }),
    ]) {
      const Shape = z.strictObject({ a: z.string(), b: z.string(), c: inner });
      const { shared } = compileSchemas(
        [
          { exportName: "A", schema: z.strictObject({ x: Shape, y: Shape }) },
          { exportName: "B", schema: z.strictObject({ z: Shape }) },
        ],
        { mode: "inline" },
      );
      expect(shared.code).not.toContain("__rf[");
    }
  });

  it("a shared stripping walk delivers its rebuild to the call site", () => {
    // The write-back crux. A shared walk that returned nothing would leave the
    // caller holding the UNSTRIPPED input, so every one of these would carry the
    // `junk` key through. The eager, unmodelled-mutation root matters most: its
    // walk output IS the parse result, where the build-path root only uses the
    // walk for errors.
    const Address = z.object({ street: z.string().min(1), city: z.string() });
    const Deferred = z.object({ home: Address, work: Address });
    const Eager = z.object({ q: z.string().trim().url(), home: Address });
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "Deferred", schema: Deferred },
        { exportName: "Eager", schema: Eager },
      ],
      { mode: "inline" },
    );
    expect(shared.code).toContain("__zcSw_0");
    expect(refs(pick(schemas, "Eager"))).toContain("__zcSw_0");

    const deferred = build(pick(schemas, "Deferred"), shared.code);
    const eager = build(pick(schemas, "Eager"), shared.code);
    const dirty = { street: "s", city: "c", junk: 1 };

    // Deferred root: the build pass produces the payload, so its walk only ever
    // reports issues — and it must still report them through the shared call.
    expect(deferred({ home: dirty, work: dirty })).toStrictEqual({
      success: true,
      data: { home: { street: "s", city: "c" }, work: { street: "s", city: "c" } },
    });
    const bad = deferred({ home: { street: "", city: "c" }, work: dirty });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.path.join("."))).toStrictEqual(["home.street"]);

    // Eager root: the shared walk's RETURN VALUE is what lands in `data`.
    expect(eager({ q: "  https://example.com  ", home: dirty })).toStrictEqual({
      success: true,
      data: { q: "https://example.com", home: { street: "s", city: "c" } },
    });
  });

  it("shares a shape carrying a zero-capture callback", () => {
    // No `__rf` involved: the predicate is hosted from its source text into the
    // shared block, so the shape stays shareable.
    const Shape = z.strictObject({
      a: z.string(),
      b: z.string(),
      c: z.string().refine((v) => v.length > 3),
    });
    const { shared } = compileSchemas(
      [
        { exportName: "A", schema: z.strictObject({ x: Shape, y: Shape }) },
        { exportName: "B", schema: z.strictObject({ z: Shape }) },
      ],
      { mode: "inline" },
    );
    expect(shared.code).toContain("__zcSw_0");
    expect(shared.code).not.toContain("__rf[");
  });

  it("excludes recursive shapes and still validates correctly", () => {
    const makeTree = () => {
      const Tree: z.ZodType = z.lazy(() =>
        z.strictObject({ value: z.number(), children: z.array(Tree) }),
      );
      return Tree;
    };
    const T1 = makeTree();
    const T2 = makeTree();
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "T1", schema: T1 },
        { exportName: "T2", schema: T2 },
      ],
      { mode: "inline" },
    );
    // Recursive shapes are never hoisted into a shared walk.
    expect(shared.code).toBe("");
    expect(refs(pick(schemas, "T1"))).toHaveLength(0);

    const compiled = build(pick(schemas, "T1"), shared.code);
    const valid = { value: 1, children: [{ value: 2, children: [] }] };
    const invalid = { value: "x", children: [] };
    expect(compiled(valid).success).toBe(T1.safeParse(valid).success);
    expect(compiled(invalid).success).toBe(T1.safeParse(invalid).success);
  });

  // Each shared shape exercises a different slow generator (and, for records,
  // a `__zcHop` that also appears in the per-schema fast-path preamble — must
  // not collide across the module/IIFE scope boundary).
  it.each([
    [
      "strictObject",
      z.strictObject({ a: z.string(), b: z.number().int(), c: z.boolean() }),
      [
        { a: "x", b: 1, c: true },
        { a: "x", b: 1.5, c: true },
        { a: "x", b: 1, c: true, extra: 9 },
        "no",
      ],
    ],
    [
      "discriminatedUnion",
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("a"), x: z.number() }),
        z.strictObject({ kind: z.literal("b"), y: z.string().min(2) }),
      ]),
      [{ kind: "a", x: 1 }, { kind: "b", y: "z" }, { kind: "c" }, "no"],
    ],
    [
      "union",
      z.union([
        z.strictObject({ p: z.string(), q: z.number() }),
        z.strictObject({ r: z.boolean(), s: z.string() }),
      ]),
      [{ p: "s", q: 1 }, { p: "s", q: "bad" }, 5],
    ],
    [
      "tuple",
      z.tuple([z.string(), z.number().int(), z.boolean()]),
      [["s", 1, true], ["s", 1.5, true], ["s", 1], "no"],
    ],
    [
      "record",
      z.record(z.string(), z.number().nonnegative()),
      [{ a: 1, b: 2 }, { a: -1 }, { a: "x" }, 5],
    ],
    [
      "refine",
      z.strictObject({ name: z.string().refine((v) => v.length > 2), age: z.number() }),
      [
        { name: "abc", age: 1 },
        { name: "ab", age: 1 },
        { name: "abc", age: "x" },
      ],
    ],
  ] as [string, z.ZodType, unknown[]][])(
    "shares a %s shape and validates identically to zod (standalone + nested)",
    (_name, Shape, inputs) => {
      // strictObject: a genuine z.strictObject() strips, and a stripping walk has to
      // produce its rebuilt value — which a shared body cannot return. Every
      // shape here is a pass-through kind for the same reason.
      const Wrap = z.strictObject({ left: Shape, right: Shape });
      const { schemas, shared } = compileSchemas(
        [
          { exportName: "Shape", schema: Shape },
          { exportName: "Wrap", schema: Wrap },
        ],
        { mode: "inline" },
      );
      expect(shared.code).toContain("__zcSw_0");

      const compiledShape = build(pick(schemas, "Shape"), shared.code);
      const compiledWrap = build(pick(schemas, "Wrap"), shared.code);
      for (const input of inputs) {
        expect(shape(compiledShape(input))).toBe(shape(Shape.safeParse(input)));
        const wrapped = { left: input, right: input };
        expect(shape(compiledWrap(wrapped))).toBe(shape(Wrap.safeParse(wrapped)));
      }
    },
  );

  it("keys non-finite check bounds distinctly (no false merge)", () => {
    const A = z.strictObject({
      a: z.number().gte(Number.POSITIVE_INFINITY),
      b: z.string(),
      c: z.boolean(),
    });
    const B = z.strictObject({
      a: z.number().gte(Number.NEGATIVE_INFINITY),
      b: z.string(),
      c: z.boolean(),
    });
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "UsesA1", schema: z.strictObject({ x: A }) },
        { exportName: "UsesA2", schema: z.strictObject({ y: A }) },
        { exportName: "UsesB", schema: z.strictObject({ w: B }) },
      ],
      { mode: "inline" },
    );
    // A repeats → shared once; B's bound differs (−Infinity vs Infinity, both
    // "null" under JSON.stringify) and must NOT merge into A.
    expect((shared.code.match(/function __zcSw_\d+/g) ?? []).length).toBe(1);
    const usesB = build(pick(schemas, "UsesB"), shared.code);
    const sample = { w: { a: 5, b: "x", c: true } };
    expect(shape(usesB(sample))).toBe(shape(z.strictObject({ w: B }).safeParse(sample)));
  });

  it("registers shared runtime helpers for lean-mode imports", () => {
    const Address = z.strictObject({
      street: z.string(),
      city: z.string(),
      zip: z.string().min(3),
    });
    const { shared } = compileSchemas(
      [
        { exportName: "User", schema: z.strictObject({ a: Address, b: Address }) },
        { exportName: "Co", schema: z.strictObject({ hq: Address }) },
      ],
      { mode: "lean" },
    );
    // Lean mode routes issue factories through the runtime module; the shared
    // block's helpers must be surfaced so the file imports them.
    expect(shared.code).toContain("__zcSw_0");
    expect([...shared.usedHelpers].length).toBeGreaterThan(0);
    expect(shared.usedHelpers).toContain("__zcIT");
  });

  it("extends a shared walk's opaque path without Array.prototype.concat", () => {
    // Money nests inside LineItem and both repeat, so LineItem's shared walk
    // calls Money's with a path built from its own `path` parameter — an
    // argument an eager walk evaluates on every parse, valid input included.
    const Money = z.strictObject({ amount: z.number().int(), currency: z.string().length(3) });
    const LineItem = z.strictObject({
      sku: z.string().min(1),
      price: Money,
      tax: Money,
      tags: z.array(z.string().min(1)),
    });
    const Order = z.strictObject({ id: z.string(), items: z.array(LineItem), total: Money });
    const Quote = z.strictObject({ ref: z.string(), lines: z.array(LineItem) });
    const exports = [
      { exportName: "Order", schema: Order },
      { exportName: "Quote", schema: Quote },
    ];
    const { schemas, shared } = compileSchemas(exports, { mode: "inline" });
    expect(shared.code).toContain('__zcPa(path,"price")');
    expect(shared.code).not.toContain("path.concat(");

    const line = {
      sku: "A-1",
      price: { amount: 100, currency: "USD" },
      tax: { amount: 8, currency: "USD" },
      tags: ["x"],
    };
    const total = { amount: 216, currency: "USD" };
    const checks: [string, z.ZodType, unknown][] = [
      ["Order", Order, { id: "o1", items: [line, line], total }],
      // Issues two shared walks deep, and at an array index inside one of them.
      [
        "Order",
        Order,
        {
          id: "o1",
          items: [line, { ...line, tax: { amount: 1.5, currency: "US" }, tags: ["ok", ""] }],
          total,
        },
      ],
      ["Quote", Quote, { ref: "q1", lines: [{ ...line, price: "free" }] }],
    ];
    for (const [name, zod, input] of checks) {
      const compiled = build(pick(schemas, name), shared.code)(input);
      const native = zod.safeParse(input);
      expect(compiled.success).toBe(native.success);
      expect(shape(compiled)).toBe(shape(native));
    }

    // Lean mode imports the helper from the runtime module instead.
    expect(compileSchemas(exports, { mode: "lean" }).shared.usedHelpers).toContain("__zcPa");
  });
});

describe("file-level Set dedupe", () => {
  const values = ["community", "course", "ebook", "event", "physical", "other"] as const;

  it("shares an identical enum Set across exported validators", () => {
    const A = z.enum(values);
    const B = z.enum(values);
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A", schema: A },
        { exportName: "B", schema: B },
      ],
      { mode: "inline" },
    );

    expect((shared.code.match(/new Set\(/g) ?? []).length).toBe(1);
    expect(shared.code).toContain("var __zcSet_0=");
    for (const schema of schemas) {
      expect(source(schema)).toContain("__zcSet_0.has(");
      expect(source(schema)).not.toContain("new Set(");
    }

    for (const [name, zod] of [
      ["A", A],
      ["B", B],
    ] as const) {
      const compiled = build(pick(schemas, name), shared.code);
      expect(shape(compiled("community"))).toBe(shape(zod.safeParse("community")));
      expect(shape(compiled("invalid"))).toBe(shape(zod.safeParse("invalid")));
    }
  });

  it("keeps unique and differently ordered Sets local", () => {
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A", schema: z.enum(values) },
        { exportName: "B", schema: z.enum([...values].reverse() as [string, ...string[]]) },
        { exportName: "C", schema: z.enum(["one", "two", "three", "four", "five", "six"]) },
      ],
      { mode: "inline" },
    );

    expect(shared.code).not.toContain("__zcSet_");
    for (const schema of schemas) expect(source(schema)).toContain("new Set(");
  });

  it("does not rewrite enum values that resemble generated identifiers", () => {
    const tricky = ["__set_enum_0.has(", "two", "three", "four", "five", "six"] as const;
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A", schema: z.enum(tricky) },
        { exportName: "B", schema: z.enum(tricky) },
      ],
      { mode: "inline" },
    );
    const generated = shared.code + schemas.map(source).join("\n");

    // Once in the shared Set and once in each validator's invalid-value issue.
    expect((generated.match(/"__set_enum_0\.has\("/g) ?? []).length).toBe(3);
    expect(generated).not.toContain('"__zcSet_0.has("');
  });

  it("shares an identical RegExp across validators", () => {
    const slug = /^[a-z0-9-]+$/;
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A", schema: z.object({ slug: z.string().regex(slug) }) },
        { exportName: "B", schema: z.object({ path: z.string().regex(slug) }) },
      ],
      { mode: "inline" },
    );

    expect((shared.code.match(/new RegExp\(/g) ?? []).length).toBe(1);
    expect(shared.code).toContain("var __zcRx_0=");
    for (const schema of schemas) {
      expect(source(schema)).toContain("__zcRx_0.test(");
      expect(source(schema)).not.toContain("new RegExp(");
    }

    for (const [name, zod] of [
      ["A", z.object({ slug: z.string().regex(slug) })],
      ["B", z.object({ path: z.string().regex(slug) })],
    ] as const) {
      const compiled = build(pick(schemas, name), shared.code);
      const key = name === "A" ? "slug" : "path";
      expect(shape(compiled({ [key]: "ok-1" }))).toBe(shape(zod.safeParse({ [key]: "ok-1" })));
      expect(shape(compiled({ [key]: "NOPE" }))).toBe(shape(zod.safeParse({ [key]: "NOPE" })));
    }
  });

  it("keeps a stateful (g/y) RegExp local to its validator", () => {
    // `.test()` advances lastIndex, so a module-scope instance would let one
    // export's match decide where another export's next call starts.
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A", schema: z.object({ a: z.string().regex(/ab/g) }) },
        { exportName: "B", schema: z.object({ b: z.string().regex(/ab/g) }) },
      ],
      { mode: "inline" },
    );

    expect(shared.code).not.toContain("__zcRx_");
    for (const schema of schemas) expect(source(schema)).toContain('new RegExp("ab","g")');
  });

  it("shares an identical iso.datetime pattern in inline mode", () => {
    // The pattern is ~330 characters and recurs across a whole API surface.
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A", schema: z.object({ at: z.iso.datetime() }) },
        { exportName: "B", schema: z.object({ seenAt: z.iso.datetime() }) },
      ],
      { mode: "inline" },
    );

    expect((shared.code.match(/new RegExp\(/g) ?? []).length).toBe(1);
    for (const schema of schemas) expect(source(schema)).not.toContain("new RegExp(");
  });

  it("shares one build-FAIL sentinel across rebuilding validators", () => {
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A", schema: z.object({ a: z.string() }) },
        { exportName: "B", schema: z.object({ b: z.number() }) },
      ],
      { mode: "inline" },
    );

    expect(shared.code).toContain("var __zcBf_0=");
    for (const schema of schemas) {
      expect(source(schema)).toContain("!==__zcBf_0");
      expect(source(schema)).not.toMatch(/var __bf_\d+=\{\};/);
    }

    for (const [name, zod] of [
      ["A", z.object({ a: z.string() })],
      ["B", z.object({ b: z.number() })],
    ] as const) {
      const compiled = build(pick(schemas, name), shared.code);
      const key = name === "A" ? "a" : "b";
      const ok = { [key]: name === "A" ? "x" : 1 };
      // `data` matters more than the verdict here: a sentinel that leaked into
      // a built value would surface as the shared object, not as a bad verdict.
      const got = compiled(ok) as { data?: unknown };
      expect(got.data).toStrictEqual(zod.parse(ok));
      expect(shape(compiled(ok))).toBe(shape(zod.safeParse(ok)));
      expect(shape(compiled({ [key]: null }))).toBe(shape(zod.safeParse({ [key]: null })));
      expect(shape(compiled(null))).toBe(shape(zod.safeParse(null)));
    }
  });

  it("does not pool a constant that survived generation unreferenced", () => {
    // The build path names its FAIL sentinel before it can decline, so these
    // two leave a declaration nothing reads. Pooling on the strength of a
    // surviving DECLARATION hoisted an unreferenced constant to module scope
    // and tripped the regeneration pass for a file that gained nothing.
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A", schema: z.map(z.string(), z.object({ a: z.string() })) },
        { exportName: "B", schema: z.set(z.object({ b: z.string() })) },
      ],
      { mode: "inline" },
    );

    for (const schema of schemas) {
      const text = source(schema);
      const sentinel = /var (__bf_\d+)=\{\};/.exec(text)?.[1];
      if (sentinel === undefined) continue;
      expect(text.split(sentinel)).toHaveLength(2); // declared, never read
    }
    expect(shared.code).not.toContain("__zcBf_");
  });

  it("keeps the sentinel local when only one validator rebuilds", () => {
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A", schema: z.object({ a: z.string() }) },
        { exportName: "B", schema: z.string().min(1) },
      ],
      { mode: "inline" },
    );

    expect(shared.code).not.toContain("__zcBf_");
    expect(source(schemas[0] as CompiledSchemaInfo)).toMatch(/var __bf_\d+=\{\};/);
  });

  it("shares Sets in compact mode independently of slow-walk dedupe", () => {
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A", schema: z.enum(values) },
        { exportName: "B", schema: z.enum(values) },
      ],
      { mode: "lean", compact: true },
    );

    expect((shared.code.match(/new Set\(/g) ?? []).length).toBe(1);
    expect(shared.code).toContain("__zcSet_0");
    expect(shared.code).not.toContain("__zcSw_");
    for (const schema of schemas) {
      expect(source(schema)).toContain("__zcSet_0.has(");
      expect(source(schema)).not.toContain("new Set(");
      expect(source(schema)).not.toContain("__sw_");
    }
  });
});

/**
 * Structural-key near-misses: two shapes identical EXCEPT one discriminating
 * detail must NOT merge. `keyOf` (dedupe.ts) serializes every IR field — each
 * check's bound, `inclusive` flag, regex source+flags, literal value, baked
 * message, and the presence/optionality of every property — so two shapes that
 * validate differently get different keys. The pre-existing coverage pinned
 * only ONE near-miss (non-finite bounds, which JSON.stringify collapses to
 * "null"); a `keyOf` that dropped any of these other fields would silently make
 * one export validate with the other's rules. Each pair embeds its shape twice
 * (so it is a sharing candidate) and feeds an input that A accepts but B does
 * not — a wrong merge makes one export diverge from zod.
 */
describe("schema dedupe — near-miss keys must not merge", () => {
  /** Build A1 = {p:A,q:A} and B1 = {p:B,q:B}, assert each matches zod for `wrap`. */
  function assertDistinct(A: z.ZodType, B: z.ZodType, sample: unknown) {
    const A1 = z.object({ p: A, q: A });
    const B1 = z.object({ p: B, q: B });
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A1", schema: A1 },
        { exportName: "B1", schema: B1 },
      ],
      { mode: "inline" },
    );
    const wrap = { p: sample, q: sample };
    expect(shape(build(pick(schemas, "A1"), shared.code)(wrap))).toBe(shape(A1.safeParse(wrap)));
    expect(shape(build(pick(schemas, "B1"), shared.code)(wrap))).toBe(shape(B1.safeParse(wrap)));
  }

  // Each pair is a 3-field object (weight ≥ 4 → a real sharing candidate) that
  // differs in exactly one check/structure detail; `sample` passes A, fails B.
  it.each([
    [
      "min vs max bound",
      z.object({ n: z.number().min(5), x: z.string(), y: z.string() }),
      z.object({ n: z.number().max(5), x: z.string(), y: z.string() }),
      { n: 10, x: "a", y: "b" },
    ],
    [
      "inclusive vs exclusive (gte vs gt)",
      z.object({ n: z.number().gte(5), x: z.string(), y: z.string() }),
      z.object({ n: z.number().gt(5), x: z.string(), y: z.string() }),
      { n: 5, x: "a", y: "b" },
    ],
    [
      "regex flags (case-insensitive vs not)",
      z.object({ s: z.string().regex(/^a$/), x: z.string(), y: z.string() }),
      z.object({ s: z.string().regex(/^a$/i), x: z.string(), y: z.string() }),
      { s: "A", x: "a", y: "b" },
    ],
    [
      "literal value differs",
      z.object({ k: z.literal("a"), x: z.string(), y: z.string() }),
      z.object({ k: z.literal("b"), x: z.string(), y: z.string() }),
      { k: "a", x: "a", y: "b" },
    ],
    [
      "optional vs required field",
      z.object({ a: z.string(), b: z.string(), c: z.string().optional() }),
      z.object({ a: z.string(), b: z.string(), c: z.string() }),
      { a: "x", b: "y" },
    ],
    [
      "string min length differs",
      z.object({ s: z.string().min(2), x: z.string(), y: z.string() }),
      z.object({ s: z.string().min(3), x: z.string(), y: z.string() }),
      { s: "ab", x: "a", y: "b" },
    ],
  ] as [string, z.ZodType, z.ZodType, unknown][])("keeps distinct: %s", (_name, A, B, sample) =>
    assertDistinct(A, B, sample),
  );

  it("two shapes differing only in a baked custom message stay distinct", () => {
    // Same predicate, different message: identical code+path on failure, so the
    // ONLY observable difference is `issue.message`. `keyOf` must include the
    // baked message or the two merge and one export reports the other's text.
    const A = z.object({ n: z.number().min(5, "alpha"), x: z.string(), y: z.string() });
    const B = z.object({ n: z.number().min(5, "beta"), x: z.string(), y: z.string() });
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A1", schema: z.object({ p: A, q: A }) },
        { exportName: "B1", schema: z.object({ p: B, q: B }) },
      ],
      { mode: "inline" },
    );
    const wrap = { p: { n: 1, x: "a", y: "b" }, q: { n: 1, x: "a", y: "b" } };
    const firstMsg = (r: { error?: { issues: { message?: string }[] } }) =>
      r.error?.issues[0]?.message;
    expect(firstMsg(build(pick(schemas, "A1"), shared.code)(wrap))).toBe("alpha");
    expect(firstMsg(build(pick(schemas, "B1"), shared.code)(wrap))).toBe("beta");
  });
});
