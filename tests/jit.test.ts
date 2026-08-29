/**
 * Runtime compilation (`zod-compiler/jit`).
 *
 * `jit()` runs the same extract → codegen pipeline the plugin and CLI run, so
 * validator correctness is already covered by the differential parity suite.
 * What is specific to this entry point, and what these tests pin, is the
 * INSTALLATION contract:
 *
 *  - compilation is deferred to first use, so importing a module of schemas
 *    costs nothing;
 *  - the compiled methods land on the original schema object, keeping Zod
 *    interop (identity, `.shape`, `instanceof`, `toJSONSchema`, `.meta()`,
 *    composition into a parent schema) intact;
 *  - `~standard` is replaced too, since Standard Schema consumers never read
 *    `.safeParse`;
 *  - anything that stops runtime codegen — `z.config({ jitless: true })`, a
 *    CSP that blocks `new Function`, a schema the pipeline throws on — leaves
 *    a working plain-Zod schema rather than a broken one;
 *  - Zod keeps the parse methods on the prototype and installs a bound own
 *    copy on first read, so a schema reaches `jit()` either untouched (no own
 *    `safeParse` at all) or already carrying the copies. Both shapes compile,
 *    and both degrade back to exactly what they held.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { core, z } from "zod";
import { jit, jitAll } from "#src/jit.js";

/** Comparable shape for a parse result — Zod and the compiler agree on all of it. */
function normalize(result: {
  data?: unknown;
  error?: { issues: { code: string; message: string; path: PropertyKey[] }[] };
  success: boolean;
}): unknown {
  return result.success
    ? { data: result.data, success: true }
    : {
        issues: result.error?.issues.map((i) => ({
          code: i.code,
          message: i.message,
          path: i.path,
        })),
        success: false,
      };
}

/**
 * The `.name` of whatever function currently occupies the schema's `safeParse`
 * slot — `safeParse_jit` once compiled. Read off the descriptor rather than the
 * property so the lazy accessor is not triggered just by looking.
 */
function safeParseName(schema: object): string | undefined {
  const value = Object.getOwnPropertyDescriptor(schema, "safeParse")?.value as
    | { name?: string }
    | undefined;
  return value?.name;
}

/**
 * Is `slot` fronted by an own getter rather than holding a method outright?
 * Zod's own getters live on the prototype, so an untouched schema answers
 * `false` for every slot; only `jit()` puts an accessor on the instance.
 */
function isAccessor(target: object, slot: string): boolean {
  return typeof Object.getOwnPropertyDescriptor(target, slot)?.get === "function";
}

/** Read every slot `jit()` fronts, so Zod installs its bound own copies first. */
function materializedByZod<T extends z.ZodType>(schema: T): T {
  const record = schema as unknown as Record<string, unknown>;
  for (const slot of ["parse", "safeParse", "parseAsync", "safeParseAsync", "~standard"]) {
    void record[slot];
  }
  return schema;
}

/**
 * The `.name` of the own `safeParse` Zod installs on first read — how a test
 * tells "plain Zod, not compiled". An untouched schema has no own `safeParse`
 * at all, so this is taken after one read.
 */
const ZOD_OWN_SAFE_PARSE_NAME = safeParseName(materializedByZod(z.object({ a: z.string() })));

function expectParity(make: () => z.ZodType, inputs: unknown[]): void {
  const plain = make();
  const compiled = jit(make());
  for (const input of inputs) {
    expect(normalize(compiled.safeParse(input)), `input ${JSON.stringify(input)}`).toStrictEqual(
      normalize(plain.safeParse(input)),
    );
  }
}

afterEach(() => {
  delete core.globalConfig.jitless;
});

describe("jit() — lazy installation", () => {
  it("installs an accessor rather than compiling at call time", () => {
    const schema = jit(z.object({ a: z.string() }));
    const descriptor = Object.getOwnPropertyDescriptor(schema, "safeParse");
    expect(typeof descriptor?.get).toBe("function");
    expect(descriptor?.value).toBeUndefined();
  });

  it("compiles on first use and replaces the accessor with the compiled method", () => {
    const schema = jit(z.object({ a: z.string() }));
    expect(schema.safeParse({ a: "x" }).success).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(schema, "safeParse");
    expect(typeof descriptor?.get).toBe("undefined");
    expect(descriptor?.value).toBeTypeOf("function");
    expect(safeParseName(schema)).toBe("safeParse_jit");
  });

  it("compiles immediately under { eager: true }", () => {
    const schema = jit(z.object({ a: z.string() }), { eager: true });
    expect(typeof Object.getOwnPropertyDescriptor(schema, "safeParse")?.get).toBe("undefined");
    expect(safeParseName(schema)).toBe("safeParse_jit");
  });

  it("preserves Zod's own-key enumerability, so the schema's shape is unchanged", () => {
    // An untouched schema has no own method keys; one Zod already read has
    // enumerable own copies. The accessor fronting each slot must match.
    expect(Object.keys(jit(z.object({ a: z.string() })))).toStrictEqual(
      Object.keys(z.object({ a: z.string() })),
    );
    expect(Object.keys(jit(materializedByZod(z.object({ a: z.string() }))))).toStrictEqual(
      Object.keys(materializedByZod(z.object({ a: z.string() }))),
    );
  });

  it("fronts the own copies Zod already installed and compiles over them", () => {
    const schema = materializedByZod(z.object({ a: z.string() }));
    expect(safeParseName(schema)).toBe(ZOD_OWN_SAFE_PARSE_NAME);
    jit(schema);
    expect(isAccessor(schema, "safeParse")).toBe(true);
    expect(schema.safeParse({ a: "x" }).success).toBe(true);
    expect(safeParseName(schema)).toBe("safeParse_jit");
  });

  it("is idempotent — a second call neither recompiles nor throws", () => {
    const schema = z.object({ a: z.string() });
    expect(jit(schema)).toBe(jit(schema));
    expect(schema.safeParse({ a: "x" }).success).toBe(true);
    expect(jit(schema).safeParse({ a: "x" }).success).toBe(true);
  });

  it("lets an explicit assignment win over the pending compile", () => {
    const schema = jit(z.object({ a: z.string() }));
    const stub = (): { data: string; success: true } => ({ data: "stub", success: true });
    (schema as unknown as { safeParse: unknown }).safeParse = stub;
    expect(schema.safeParse(undefined)).toStrictEqual({ data: "stub", success: true });
  });
});

describe("jit() — parity with Zod", () => {
  it("matches on a plain object, including unknown-key stripping", () => {
    expectParity(
      () => z.object({ a: z.string().min(2), b: z.number().int() }),
      [
        { a: "xy", b: 1 },
        { a: "xy", b: 1, junk: 9 },
        { a: "x", b: 1 },
        { a: "xy", b: 1.5 },
        null,
        [],
      ],
    );
  });

  it("matches on arrays and discriminated unions", () => {
    expectParity(
      () => z.array(z.object({ id: z.uuid() })).min(1),
      [[{ id: "550e8400-e29b-41d4-a716-446655440000" }], [], [{ id: "not-a-uuid" }]],
    );
    expectParity(
      () =>
        z.discriminatedUnion("t", [
          z.object({ t: z.literal("a"), x: z.number() }),
          z.object({ t: z.literal("b"), y: z.string() }),
        ]),
      [{ t: "a", x: 1 }, { t: "b", y: "s" }, { t: "c" }],
    );
  });

  it("matches on effects, whose callbacks are parsed from fn.toString() at runtime", () => {
    const min = 3;
    expectParity(
      () =>
        z.object({
          captured: z.string().refine((v) => v.length >= min, "too short"),
          defaulted: z.number().default(7),
          rewritten: z.string().transform((v) => v.trim().toLowerCase()),
        }),
      [
        { captured: "abcd", rewritten: " AB " },
        { captured: "ab", rewritten: " AB " },
        { captured: "abcd", defaulted: 1, rewritten: " AB " },
      ],
    );
  });

  it("matches on constructs that fall back to Zod", () => {
    expectParity(
      () => z.object({ c: z.custom((v) => v === 1), u: z.url() }),
      [
        { c: 1, u: "https://example.com" },
        { c: 2, u: "https://example.com" },
        { c: 1, u: "nope" },
      ],
    );
  });

  it("matches on recursive schemas", () => {
    const make = (): z.ZodType => {
      const node: z.ZodType = z.lazy(() => z.object({ kids: z.array(node), v: z.number() }));
      return node;
    };
    expectParity(make, [
      { kids: [{ kids: [], v: 2 }], v: 1 },
      { kids: [{ kids: [], v: "x" }], v: 1 },
    ]);
  });
});

describe("jit() — installed surface", () => {
  it("exposes the whole CompiledSchema surface", async () => {
    const schema = jit(z.object({ a: z.string() }));
    expect(schema.parse({ a: "x" })).toStrictEqual({ a: "x" });
    expect(() => schema.parse({ a: 1 })).toThrow();
    expect(await schema.parseAsync({ a: "x" })).toStrictEqual({ a: "x" });
    expect((await schema.safeParseAsync({ a: "x" })).success).toBe(true);
    expect(schema.is({ a: "x" })).toBe(true);
    expect(schema.is({ a: 1 })).toBe(false);
  });

  it("routes ~standard through the compiled validator", () => {
    const schema = jit(z.object({ a: z.string().min(3) }));
    const standard = (schema as unknown as Record<string, { validate: (v: unknown) => unknown }>)[
      "~standard"
    ];
    expect(standard?.validate({ a: "abc" })).toStrictEqual({ value: { a: "abc" } });
    expect(standard?.validate({ a: "" })).toHaveProperty("issues");
  });

  it("keeps Zod interop — identity, shape, instanceof, metadata, composition", () => {
    const original = z.object({ a: z.string() }).meta({ id: "MySchema", title: "T" });
    const compiled = jit(original);
    expect(compiled).toBe(original);
    expect(compiled).toBeInstanceOf(z.ZodObject);
    expect(Object.keys(compiled.shape)).toStrictEqual(["a"]);
    expect(z.toJSONSchema(compiled)).toMatchObject({ title: "T", type: "object" });
    expect(z.object({ nested: compiled }).safeParse({ nested: { a: "y" } }).success).toBe(true);
  });
});

describe("jitAll()", () => {
  it("compiles every Zod schema among an object's values and ignores the rest", () => {
    const namespace = Object.freeze({
      Other: z.array(z.number()),
      User: z.object({ a: z.string() }),
      notASchema: 42,
    });
    jitAll(namespace);
    expect(namespace.User.safeParse({ a: "x" }).success).toBe(true);
    expect(safeParseName(namespace.User)).toBe("safeParse_jit");
    expect(namespace.Other.safeParse([1]).success).toBe(true);
    expect(namespace.notASchema).toBe(42);
  });

  /**
   * The documented call is `jitAll(moduleNamespace)`, so the probe meets every
   * export of that module — including values that answer back. A Proxy can trap
   * `has` and `get` and throw: an ORM model, a strict test double, an i18n
   * catch-all. `"_zod" in value` fires the first and reading `_zod` the second,
   * and an uncaught throw there aborts the importing app at boot over a value
   * that was never a schema candidate.
   */
  it.each([
    [
      "a catch-all proxy that throws on unknown reads",
      new Proxy(
        {},
        {
          has: () => true,
          get: (_t, key) => {
            throw new Error(`unknown column: ${String(key)}`);
          },
        },
      ),
    ],
    [
      "a proxy whose `has` trap throws",
      new Proxy(
        {},
        {
          has: () => {
            throw new Error("has trap exploded");
          },
        },
      ),
    ],
  ])("survives %s among the values", (_name, hostile) => {
    const namespace = Object.freeze({ User: z.object({ a: z.string() }), hostile });
    expect(() => {
      jitAll(namespace);
    }).not.toThrow();
    // The real schema alongside it is still compiled (reading safeParse first
    // materializes the lazy accessor, as in the case above).
    expect(namespace.User.safeParse({ a: "x" }).success).toBe(true);
    expect(safeParseName(namespace.User)).toBe("safeParse_jit");
  });
});

describe("jit() — degradation", () => {
  it("leaves a working plain-Zod schema under z.config({ jitless: true })", () => {
    core.globalConfig.jitless = true;
    const schema = jit(z.object({ a: z.string().min(2) }));
    expect(schema.safeParse({ a: "xy" }).success).toBe(true);
    expect(schema.safeParse({ a: "x" }).success).toBe(false);
    // The accessor is gone and the slot holds what a never-jitted schema would
    // after one read: the bound own copy Zod's prototype getter installs.
    expect(isAccessor(schema, "safeParse")).toBe(false);
    expect(safeParseName(schema)).toBe(ZOD_OWN_SAFE_PARSE_NAME);
  });

  it("hands back the very own copies Zod had installed before jit()", () => {
    core.globalConfig.jitless = true;
    const schema = materializedByZod(z.object({ a: z.string().min(2) }));
    const ownValue = (slot: string): unknown =>
      Object.getOwnPropertyDescriptor(schema, slot)?.value;
    const own = ownValue("safeParse");
    const standard = ownValue("~standard");
    jit(schema);
    expect(schema.safeParse({ a: "x" }).success).toBe(false);
    // Restored by identity, not re-bound: the own copy taken before jit() and
    // the one on the slot after it are the same function.
    expect(ownValue("safeParse")).toBe(own);
    expect(ownValue("~standard")).toBe(standard);
  });

  it("yields to an AOT install without recursing (jit() plus the build plugin)", () => {
    // The plugin emits `__zcMkv(fn, jit(schema), fc, is)`: it ASSIGNS the parse
    // methods and then READS `~standard`. If cancelling on assignment left the
    // other accessors in place, that read re-entered itself forever.
    const schema = jit(z.object({ a: z.string() }));
    const aot = (): { data: string; success: true } => ({ data: "aot", success: true });
    (schema as unknown as { safeParse: unknown }).safeParse = aot;
    expect(() => (schema as unknown as Record<string, unknown>)["~standard"]).not.toThrow();
    expect(schema.safeParse(undefined)).toStrictEqual({ data: "aot", success: true });
    // Everything the AOT install did not overwrite is Zod's own, not a stub.
    expect(schema.parse({ a: "x" })).toStrictEqual({ a: "x" });
  });

  it("does not throw when a method slot is locked non-configurable", () => {
    // `jit()` is called at module scope, so a throw here takes down the
    // importing app at boot. The own copy Zod installs on first read is
    // configurable, but that is an unversioned internal — and another wrapper
    // can lock a slot too.
    const schema = z.object({ a: z.string().min(2) });
    Object.defineProperty(schema, "safeParse", {
      configurable: false,
      value: schema.safeParse.bind(schema),
      writable: false,
    });
    expect(() => jit(schema)).not.toThrow();
    expect(schema.safeParse({ a: "xy" }).success).toBe(true);
    expect(schema.safeParse({ a: "x" }).success).toBe(false);
  });

  /**
   * The same promise, held against a target that fails ASYMMETRICALLY — it
   * answers the descriptor snapshot or the install with a throw. Rolling back is
   * itself a `defineProperty`, so a target that refuses that too could make the
   * rollback escape the very guard meant to contain it.
   */
  it("does not throw when the target refuses a descriptor query", () => {
    const schema = z.object({ a: z.string().min(2) });
    const hostile = new Proxy(schema, {
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor query refused");
      },
    });
    expect(() => jit(hostile)).not.toThrow();
    // Untouched, so Zod's own methods still answer through the proxy.
    expect(hostile.safeParse({ a: "xy" }).success).toBe(true);
  });

  it("does not throw when the target refuses every accessor install", () => {
    // Refuses exactly what jit() does — an accessor — while accepting the data
    // property Zod's own getter installs, so the schema stays usable through
    // the wrapper on Zod's path.
    const schema = z.object({ a: z.string().min(2) });
    const hostile = new Proxy(schema, {
      defineProperty: (target, key, descriptor) => {
        if (typeof descriptor.get === "function") throw new Error("accessor refused");
        return Reflect.defineProperty(target, key, descriptor);
      },
    });
    expect(() => jit(hostile)).not.toThrow();
    expect(isAccessor(schema, "parse")).toBe(false);
    expect(hostile.safeParse({ a: "xy" }).success).toBe(true);
    expect(hostile.safeParse({ a: "x" }).success).toBe(false);
  });

  it("does not throw when the target refuses defineProperty on every slot", () => {
    const schema = z.object({ a: z.string().min(2) });
    const hostile = new Proxy(schema, {
      defineProperty: () => {
        throw new Error("defineProperty refused");
      },
    });
    expect(() => jit(hostile)).not.toThrow();
    expect(isAccessor(schema, "safeParse")).toBe(false);
    // Through the wrapper, Zod's own getter meets the same refusal when it
    // installs its bound copy — so the one error a read surfaces is the trap's,
    // with nothing of jit()'s in front of it.
    expect(() => hostile.safeParse({ a: "xy" })).toThrow("defineProperty refused");
    // Nothing landed on the schema, which still works when reached directly.
    expect(schema.safeParse({ a: "xy" }).success).toBe(true);
    expect(schema.safeParse({ a: "x" }).success).toBe(false);
  });

  /**
   * Installation reaches the slots before `safeParseAsync` and then throws, so
   * rollback has real work: those slots must go back to what Zod had even
   * though the refusing one cannot. Rollback is a delete on an untouched
   * schema (the slot goes back to the prototype) and a defineProperty on one
   * Zod already materialized (the own copy goes back), so both are recorded.
   */
  it.each([
    ["an untouched schema", (schema: z.ZodType): z.ZodType => schema],
    ["a schema Zod already materialized", materializedByZod],
  ])("rolls back the slots it can when the target refuses one, on %s", (_name, shape) => {
    const schema = shape(z.object({ a: z.string().min(2) }));
    const seenKeys: string[] = [];
    const hostile = new Proxy(schema, {
      defineProperty: (target, key, descriptor) => {
        seenKeys.push(String(key));
        if (key === "safeParseAsync") throw new Error("defineProperty refused");
        return Reflect.defineProperty(target, key, descriptor);
      },
      deleteProperty: (target, key) => {
        seenKeys.push(String(key));
        return Reflect.deleteProperty(target, key);
      },
    });
    expect(() => jit(hostile)).not.toThrow();
    // Every slot installed before the refusal was also rolled back — twice in
    // `seenKeys`. Pins the partial path itself, not the order SLOTS happens to
    // have: reorder it and this fails rather than silently testing nothing.
    const installedThenRestored = seenKeys.filter((key, i) => seenKeys.indexOf(key) !== i);
    expect(installedThenRestored.length).toBeGreaterThan(0);
    for (const slot of installedThenRestored) {
      expect(isAccessor(schema, slot)).toBe(false);
    }
    expect(hostile.safeParse({ a: "xy" }).success).toBe(true);
    expect(hostile.safeParse({ a: "x" }).success).toBe(false);
  });

  /**
   * A target that refuses EVERY rollback — the delete that returns an untouched
   * slot to the prototype as much as a defineProperty — keeps its accessors, so
   * the getter is the last line of defence: `trigger()` is spent, and re-reading
   * the slot would re-enter the getter until the stack blows. It must serve
   * Zod's own method instead, and Zod's own getter is no help here: it installs
   * its bound copy with the same refused defineProperty.
   */
  it("keeps a schema usable when no slot can be rolled back", () => {
    const schema = z.object({ a: z.string().min(2) });
    let installs = 0;
    const hostile = new Proxy(schema, {
      defineProperty: (target, key, descriptor) => {
        installs += 1;
        if (installs > 1) throw new Error("defineProperty refused");
        return Reflect.defineProperty(target, key, descriptor);
      },
      deleteProperty: () => {
        throw new Error("deleteProperty refused");
      },
    });
    expect(() => jit(hostile)).not.toThrow();
    // `parse` is the slot that took an accessor and could not be rolled back.
    expect(isAccessor(schema, "parse")).toBe(true);
    expect(() => hostile.parse({ a: "xy" })).not.toThrow();
    expect(hostile.parse({ a: "xy" })).toStrictEqual({ a: "xy" });
    expect(() => hostile.parse({ a: "x" })).toThrow();
    expect(isAccessor(schema, "parse")).toBe(true);
  });

  /**
   * `Object.freeze(jit(schema))` is an ordinary defensive export. Freezing after
   * installation means the first read triggers a materialize whose restore the
   * frozen object refuses — the same stranding, reached without any Proxy. Zod
   * alone does not survive this: its getter installs the bound copy on first
   * read, which a frozen object refuses, so the accessor's fallback is the
   * only thing that makes the schema readable at all.
   */
  it("keeps a schema usable when it is frozen after jit()", () => {
    const schema = Object.freeze(jit(z.object({ a: z.string().min(2) })));
    expect(schema.safeParse({ a: "xy" }).success).toBe(true);
    expect(schema.safeParse({ a: "x" }).success).toBe(false);
    expect(schema.parse({ a: "xy" })).toStrictEqual({ a: "xy" });
    // The accessor is still there — the frozen target refused every handover —
    // so these reads came through the getter's snapshot fallback, which is the
    // path under test.
    expect(isAccessor(schema, "safeParse")).toBe(true);
    const standard = (schema as unknown as { "~standard": { validate: (v: unknown) => unknown } })[
      "~standard"
    ];
    expect(standard.validate({ a: "xy" })).toStrictEqual({ value: { a: "xy" } });
  });

  /**
   * Two copies of this module in one graph — a duplicated dependency, an
   * ESM+CJS dual load, a bundler-split chunk. `seen` is per-module, so both
   * install on the same schema and each leaves an accessor the other does not
   * recognise. Freezing then blocks both handovers, and the two getters bounced
   * reads between themselves until the stack blew. Needs no hostile Proxy.
   */
  it("keeps a schema usable when two copies of jit() install on it", async () => {
    const { jit: otherJit } = (await import("#src/jit.js?duplicate-instance")) as {
      jit: typeof jit;
    };
    expect(otherJit).not.toBe(jit);
    const schema = z.object({ a: z.string().min(2) });
    jit(schema);
    otherJit(schema);
    Object.freeze(schema);
    expect(schema.safeParse({ a: "xy" }).success).toBe(true);
    expect(schema.safeParse({ a: "x" }).success).toBe(false);
  });

  it("leaves a working plain-Zod schema when new Function is blocked", () => {
    const RealFunction = globalThis.Function;
    // Zod's own object fast-pass is a `new Function` too, so block only the
    // construction whose body is zod-compiler's — the CSP case for THIS module.
    globalThis.Function = new Proxy(RealFunction, {
      construct(target, args: unknown[]) {
        const body = args.at(-1);
        if (typeof body === "string" && body.includes("__zcMkv")) {
          throw new EvalError("Refused to evaluate a string as JavaScript");
        }
        return Reflect.construct(target, args) as object;
      },
    });
    try {
      const schema = jit(z.object({ a: z.string().min(2) }));
      expect(schema.safeParse({ a: "xy" }).success).toBe(true);
      expect(schema.safeParse({ a: "x" }).success).toBe(false);
      expect(isAccessor(schema, "safeParse")).toBe(false);
      expect(safeParseName(schema)).toBe(ZOD_OWN_SAFE_PARSE_NAME);
    } finally {
      globalThis.Function = RealFunction;
    }
  });
});

/**
 * The whole installed surface, not just `safeParse`.
 *
 * `__zcMkv` gives `parse()`, `parseAsync()` and `~standard.validate()` their own
 * by-reference shortcut over the hosted fast check (`fc`), and wraps the SYNC
 * validator for the two async methods. Both shortcuts carry contracts that
 * `safeParse` alone never exercises, and both were violated:
 *
 *  - `fc` promises that a passing check means the parse returns its INPUT. A
 *    stripping object whose build pass declined it (a `.catch()` field, say)
 *    still published one, so `z.object({a: z.number().catch(0)}).parse({a:1,b:2})`
 *    handed back the UNSTRIPPED input while its own `safeParse` returned `{a:1}`.
 *  - the async pair wrapped a validator that, for a schema the compiler cannot
 *    reproduce, calls Zod's SYNCHRONOUS safeParse — which raises
 *    `$ZodAsyncError` by design. So any schema containing an `async` refinement
 *    or a `z.promise()` rejected on `parseAsync` for EVERY input, valid ones
 *    included.
 */
describe("jit — every installed method agrees with Zod, not just safeParse", () => {
  const render = (run: () => unknown): string => {
    try {
      const value = run();
      return `ok:${JSON.stringify(value)}`;
    } catch (error) {
      if (error instanceof z.ZodError) return `throw:ZodError:${JSON.stringify(error.issues)}`;
      return `throw:${error instanceof Error ? error.constructor.name : String(error)}`;
    }
  };

  const expectSurfaceParity = (make: () => z.ZodType, inputs: unknown[]): void => {
    const plain = make();
    const compiled = jit(make(), { eager: true });
    for (const input of inputs) {
      expect(
        render(() => compiled.parse(input)),
        `parse ${String(input)}`,
      ).toBe(render(() => plain.parse(input)));
      expect(
        render(() => (compiled as unknown as StandardSchema)["~standard"].validate(input)),
        `~standard ${String(input)}`,
      ).toBe(render(() => (plain as unknown as StandardSchema)["~standard"].validate(input)));
      expect(
        render(() => (compiled as { is: (v: unknown) => boolean }).is(input)),
        `is ${String(input)}`,
      ).toBe(render(() => plain.safeParse(input).success));
    }
  };

  interface StandardSchema {
    "~standard": { validate: (value: unknown) => unknown };
  }

  it("a strip object with a catch field does not hand back the unstripped input", () =>
    expectSurfaceParity(
      () => z.object({ a: z.number().catch(0) }),
      [{ a: 1, b: 2 }, { a: "x", b: 2 }, {}],
    ));

  it("a union whose option rewrites does not hand back the input", () => {
    expectSurfaceParity(() => z.union([z.string().catch("c"), z.number()]), [1, "x", true]);
    expectSurfaceParity(
      () => z.object({ u: z.union([z.string().catch("c"), z.number()]) }),
      [{ u: 1, extra: 9 }],
    );
    expectSurfaceParity(
      () => z.record(z.string(), z.union([z.string().catch("c"), z.number()])),
      [{ k: 1 }],
    );
  });

  it("stripping, defaults and rewrites reach parse() as they reach safeParse()", () => {
    expectSurfaceParity(() => z.object({ a: z.string() }), [{ a: "x", b: 2 }, { a: 1 }]);
    expectSurfaceParity(() => z.object({ a: z.number().default(5) }), [{ a: 1, b: 2 }, {}]);
    expectSurfaceParity(() => z.object({ a: z.string().trim() }), [{ a: " x ", b: 2 }]);
    expectSurfaceParity(
      () => z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
      [{ a: "x", extra: 1 }],
    );
  });

  const ASYNC: [string, () => z.ZodType, unknown[]][] = [
    ["async refinement", () => z.string().refine(async (v) => v.length > 1), ["ab", "a", 1]],
    ["z.promise()", () => z.promise(z.string()), [Promise.resolve("x"), "x"]],
    ["async transform", () => z.string().transform(async (v) => v.length), ["ab", 1]],
    [
      "an object with one async field",
      () => z.object({ a: z.string().refine(async (v) => v.length > 1), b: z.number() }),
      [{ a: "ab", b: 1 }, { a: "a", b: 1 }, { a: 1, b: 1 }, 1],
    ],
    [
      "an array of async elements",
      () => z.array(z.string().refine(async () => true)),
      [["a"], [1]],
    ],
  ];

  for (const [label, make, inputs] of ASYNC) {
    it(`${label}: parseAsync/safeParseAsync still work`, async () => {
      const plain = make();
      const compiled = jit(make(), { eager: true });
      const settle = async (run: () => Promise<unknown>): Promise<string> => {
        try {
          return `resolved:${JSON.stringify(await run())}`;
        } catch (error) {
          if (error instanceof z.ZodError)
            return `rejected:ZodError:${JSON.stringify(error.issues)}`;
          return `rejected:${error instanceof Error ? error.constructor.name : String(error)}`;
        }
      };
      for (const input of inputs) {
        expect(await settle(() => compiled.parseAsync(input))).toBe(
          await settle(() => plain.parseAsync(input)),
        );
        expect(
          await settle(async () => normalize(await compiled.safeParseAsync(input))),
        ).toStrictEqual(await settle(async () => normalize(await plain.safeParseAsync(input))));
      }
    });

    it(`${label}: the synchronous surface is unchanged`, () => {
      expectSurfaceParity(make, inputs);
    });
  }
});
