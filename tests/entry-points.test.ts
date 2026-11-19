/**
 * Each compiled schema carries its OWN `parse()` and `~standard.validate`.
 *
 * `__zcMkv` used to build both as closures, and a closure built at one site is
 * one function to V8 however many schemas it is built for: a single feedback
 * vector, shared by every schema in the bundle. The `fc(input)` / `fn(input)`
 * calls inside therefore saw as many callees as the bundle has schemas, went
 * megamorphic, and were never inlined — invisible in a benchmark that compiles
 * one schema, and 30–50% of `parse()` on a small schema once forty are loaded.
 *
 * generateIIFE now emits the two functions beside the validator, where their
 * callees are named statically, and hands them to the factory to install. What
 * is checked here is that they are the functions installed, that they behave as
 * zod's `parse` / `validate` behave on every route through them — including the
 * routes that only exist to fail — and that the factory still serves a caller
 * that passes neither.
 */
import { describe, expect, it } from "vite-plus/test";
import { config as zodConfig, core as zodCore, ZodRealError, z } from "zod";
import {
  FAIL_CLASS_DECL,
  FAILZ_CLASS_DECL,
  FIN_DECL,
  FIN_DEFERRED_DECL,
  FINZ_DECL,
  generateIIFE,
  MK_VALIDATOR_DECL,
  ZOD_CONFIG_IMPORT,
  ZOD_MSG_DECLARATION,
} from "#src/core/iife.js";
import { compileSchemas } from "#src/core/pipeline.js";
import type { CodegenMode } from "#src/core/types.js";
import { loadVirtual, RESOLVED_RUNTIME_ID } from "#src/unplugin/virtual.js";

type StandardResult = { issues?: { message: string }[]; value?: unknown };
interface Installed {
  parse: (input: unknown) => unknown;
  safeParse: (input: unknown) => { success: boolean; data?: unknown; error?: z.ZodError };
  safeParseAsync: (input: unknown) => Promise<unknown>;
  "~standard": {
    version: number;
    vendor: string;
    validate: (input: unknown) => StandardResult | Promise<StandardResult>;
  };
}

/** What an inline-mode file declares ahead of its IIFEs (the CLI emitter, `jit()`). */
const INLINE_RUNTIME = [
  ZOD_MSG_DECLARATION,
  FAIL_CLASS_DECL,
  MK_VALIDATOR_DECL,
  FIN_DECL,
  FIN_DEFERRED_DECL,
  FAILZ_CLASS_DECL,
  FINZ_DECL,
].join("\n");

/** The runtime module a lean-mode file imports from, as a function-body head. */
const LEAN_RUNTIME = (loadVirtual(RESOLVED_RUNTIME_ID) ?? "")
  .replace(ZOD_CONFIG_IMPORT, "")
  .replaceAll(/^export /gm, "");

/**
 * Evaluate ONE module holding an IIFE per schema, as a bundle or a
 * `.compiled.ts` does: a single `__zcMkv` shared by all of them. Returns what
 * each IIFE returned — the schema itself, or a method bag with `zodCompat: false`.
 */
function installModule(
  schemas: readonly z.ZodType[],
  options?: { mode?: CodegenMode; zodCompat?: boolean; targets?: readonly unknown[] },
): Installed[] {
  const mode = options?.mode ?? "inline";
  const { schemas: compiled, shared } = compileSchemas(
    schemas.map((schema, index) => ({ exportName: `S${index}`, schema })),
    { mode },
  );
  expect(compiled).toHaveLength(schemas.length);
  const iifes = compiled.map((info, index) =>
    generateIIFE(`__schemas[${index}]`, info, { zodCompat: options?.zodCompat }),
  );
  const body = [
    mode === "lean" ? LEAN_RUNTIME : INLINE_RUNTIME,
    shared.code,
    `return [${iifes.join(",\n")}];`,
  ].join("\n");
  const factory = new Function(
    "__zodCompilerConfig",
    "__zcCore",
    "__zcZodError",
    "__schemas",
    `"use strict";${body}`,
  );
  return factory(zodConfig, zodCore, ZodRealError, options?.targets ?? schemas) as Installed[];
}

/** Compile one schema in place and hand it back as the compiled surface. */
function install<T extends z.ZodType>(schema: T, mode?: CodegenMode): T & Installed {
  installModule([schema], mode === undefined ? undefined : { mode });
  return schema as T & Installed;
}

const MODES: CodegenMode[] = ["inline", "lean"];

describe("entry points — the schema's own functions are what gets installed", () => {
  for (const mode of MODES) {
    it(`parse() and validate come from the IIFE, one pair per schema (${mode})`, () => {
      const [byReference, rebuilt] = installModule(
        [z.strictObject({ a: z.string() }), z.object({ b: z.number() })],
        { mode },
      ) as [Installed, Installed];

      for (const schema of [byReference, rebuilt]) {
        expect(schema.parse.name).toBe("__zp");
        expect(schema["~standard"].validate.name).toBe("__zv");
      }
      // Two schemas, two function LITERALS: each names its own validator, which
      // is what gives each its own feedback and a single callee to inline.
      expect(byReference.parse).not.toBe(rebuilt.parse);
      expect(String(byReference.parse)).toContain("safeParse_S0(input)");
      expect(String(rebuilt.parse)).toContain("safeParse_S1(input)");
      expect(String(byReference["~standard"].validate)).toContain("safeParse_S0(input)");
      expect(String(rebuilt["~standard"].validate)).toContain("safeParse_S1(input)");
      // Only the by-reference schema has a shortcut to take.
      expect(String(byReference.parse)).toMatch(/__fc_\d+\(input\)\?input:/);
      expect(String(rebuilt.parse)).not.toContain("?input:");
    });
  }

  it("the factory installs what it is handed, and builds its own only when handed nothing", () => {
    const mkv = new Function(`"use strict";${MK_VALIDATOR_DECL}return __zcMkv;`)() as (
      ...args: unknown[]
    ) => Installed;
    const fn = (input: unknown) => ({ success: true, data: input });
    const parse = (): number => 1;
    const validate = (): StandardResult => ({ value: 2 });

    const handed = mkv(fn, null, null, null, parse, validate);
    expect(handed.parse).toBe(parse);
    expect(handed["~standard"].validate).toBe(validate);

    // Generated code that predates the two arguments still gets a full surface.
    const legacy = mkv(fn, null, null, null);
    expect(legacy.parse.name).toBe("parse");
    expect(legacy.parse("x")).toBe("x");
    expect(legacy["~standard"].validate("x")).toStrictEqual({ value: "x" });
  });

  it("keeps the Standard Schema slot as the factory defines it", () => {
    const schema = install(z.object({ a: z.string() }));
    const descriptor = Object.getOwnPropertyDescriptor(schema, "~standard");

    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.configurable).toBe(true);
    expect(schema["~standard"].version).toBe(1);
    expect(schema["~standard"].vendor).toBe("zod");
    expect(Object.keys(schema["~standard"])).toStrictEqual(["version", "vendor", "validate"]);
  });
});

/** A schema, its inputs, and whether its valid output is the input itself. */
const CORPUS: [string, () => z.ZodType, unknown[]][] = [
  [
    "by-reference object",
    () => z.strictObject({ a: z.string().min(1), b: z.number().int() }),
    [{ a: "x", b: 1 }, { a: "", b: 1 }, { a: "x", b: 1.5 }, { a: "x", b: 1, c: 2 }, null],
  ],
  [
    "stripping object",
    () => z.object({ a: z.string().min(1), b: z.number().int() }),
    [{ a: "x", b: 1 }, { a: "x", b: 1, extra: true }, { a: 1, b: "y" }, [], undefined],
  ],
  ["primitive", () => z.string().min(3), ["abc", "a", 5]],
  ["array", () => z.array(z.number()).max(2), [[1, 2], [1, 2, 3], ["x"], {}]],
  [
    "default and overwrite",
    () => z.object({ q: z.string().trim(), n: z.number().default(3) }),
    [{ q: "  x  " }, { q: 5 }],
  ],
  ["coercion", () => z.object({ n: z.coerce.number() }), [{ n: "5" }, { n: "x" }]],
  [
    "refinement",
    () => z.object({ a: z.number(), b: z.number() }).refine((v) => v.a < v.b, "a<b"),
    [
      { a: 1, b: 2 },
      { a: 3, b: 2 },
    ],
  ],
  [
    "transform",
    () => z.object({ a: z.string().transform((s) => s.length) }),
    [{ a: "abc" }, { a: 1 }],
  ],
  ["union", () => z.union([z.string(), z.number()]), ["x", 1, true]],
  [
    "dynamic error map",
    () => z.object({ a: z.string({ error: (issue) => `bad ${typeof issue.input}` }) }),
    [{ a: "x" }, { a: 1 }],
  ],
  ["delegated to zod whole", () => z.set(z.number()).readonly(), [new Set([1]), new Set(["x"]), 1]],
];

describe("entry points — parse()", () => {
  /** Outcome of a parse: the value, or the issues it threw. */
  function outcome(schema: z.ZodType, input: unknown): unknown {
    try {
      return { value: schema.parse(input) };
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      return { issues: (error as z.ZodError).issues };
    }
  }

  for (const mode of MODES) {
    for (const [label, make, inputs] of CORPUS) {
      it(`matches zod: ${label} (${mode})`, () => {
        const plain = make();
        const compiled = install(make(), mode);
        for (const input of inputs) {
          expect(outcome(compiled, input)).toStrictEqual(outcome(plain, input));
        }
      });
    }
  }

  it("returns the input itself where the fast check proves it is the output", () => {
    const schema = install(z.strictObject({ a: z.string() }));
    const input = { a: "x" };
    expect(schema.parse(input)).toBe(input);
  });

  it("returns the rebuilt value where the schema rebuilds", () => {
    const schema = install(z.object({ a: z.string() }));
    const input = { a: "x", extra: 1 };
    expect(schema.parse(input)).toStrictEqual({ a: "x" });
    expect(input).toStrictEqual({ a: "x", extra: 1 });
  });

  /**
   * zod builds a ZodError with stack capture suppressed and restores the frames
   * in `parse()` with itself as the callee, so the trace starts at the caller.
   * The schema's own `parse` hands ITSELF to `__zcPu` for the same purpose; a
   * wrong callee would leave `__zp` (or the helpers under it) at the top.
   */
  describe("a thrown error starts at the caller's frame", () => {
    const frames = (error: unknown): string[] =>
      String((error as Error).stack)
        .split("\n")
        .filter((line) => line.trimStart().startsWith("at "));

    function throwSite(schema: { parse: (input: unknown) => unknown }, input: unknown): unknown {
      try {
        return schema.parse(input);
      } catch (error) {
        return error;
      }
    }

    const SHAPES: [string, () => z.ZodType, unknown][] = [
      ["with a by-reference shortcut", () => z.strictObject({ a: z.string() }), { a: 1 }],
      ["without one", () => z.object({ a: z.string() }), { a: 1 }],
    ];

    for (const mode of MODES) {
      for (const [label, make, bad] of SHAPES) {
        it(`${label} (${mode})`, () => {
          const plain = throwSite(make(), bad);
          const compiled = throwSite(install(make(), mode), bad);

          expect(compiled).toBeInstanceOf(z.ZodError);
          expect(frames(plain)[0]).toContain("throwSite");
          expect(frames(compiled)[0]).toBe(frames(plain)[0]);
          expect(String((compiled as Error).stack)).not.toContain("__zp");
          expect(String((compiled as Error).stack)).not.toContain("__zcPu");
        });
      }
    }
  });
});

describe("entry points — ~standard.validate", () => {
  /** Normalize a Standard Schema result (sync or async) for comparison. */
  async function settle(schema: z.ZodType, input: unknown): Promise<string> {
    let result: StandardResult | Promise<StandardResult>;
    try {
      result = (schema as unknown as Installed)["~standard"].validate(input);
    } catch (error) {
      return `THREW synchronously ${(error as Error).message}`;
    }
    const kind = result instanceof Promise ? "async" : "sync";
    try {
      const settled = await result;
      return JSON.stringify({
        kind,
        ok: settled.issues === undefined,
        value: settled.value,
        issues: settled.issues?.map((issue) => issue.message),
      });
    } catch (error) {
      return `${kind} REJECTED ${(error as Error).message}`;
    }
  }

  // The throw path: zod's validate retries through safeParseAsync, which is how
  // an async refinement resolves and how a throwing check becomes a rejection.
  const THROW_PATHS: [string, () => z.ZodType, unknown[]][] = [
    [
      "async refinement",
      () => z.object({ a: z.string() }).refine(async (value) => value.a !== "no", "async says no"),
      [{ a: "x" }, { a: "no" }, { a: 1 }],
    ],
    [
      "throwing refinement",
      () =>
        z.object({ a: z.string() }).refine(() => {
          throw new Error("boom");
        }),
      [{ a: "x" }, { a: 1 }],
    ],
    [
      "throwing transform",
      () =>
        z.string().transform((value) => {
          if (value === "bad") throw new Error("transform boom");
          return value.length;
        }),
      ["good", "bad", 1],
    ],
    [
      "error map that throws while the issues are built",
      () =>
        z.object({
          a: z.string({
            error: () => {
              throw new Error("map boom");
            },
          }),
        }),
      [{ a: "x" }, { a: 1 }],
    ],
  ];

  for (const mode of MODES) {
    for (const [label, make, inputs] of [...CORPUS, ...THROW_PATHS]) {
      it(`matches zod's own validate: ${label} (${mode})`, async () => {
        const plain = make();
        const compiled = install(make(), mode);
        for (const input of inputs) {
          expect(await settle(compiled, input), JSON.stringify(input)).toBe(
            await settle(plain, input),
          );
        }
      });
    }
  }

  it("returns the input itself where the fast check proves it is the output", () => {
    const schema = install(z.strictObject({ a: z.string() }));
    const input = { a: "x" };
    expect((schema["~standard"].validate(input) as StandardResult).value).toBe(input);
  });

  it("works when called detached from the schema, as consumers destructure it", () => {
    const { validate } = install(z.object({ a: z.string() }))["~standard"];
    expect(validate({ a: "x", extra: 1 })).toStrictEqual({ value: { a: "x" } });
    expect((validate({ a: 1 }) as StandardResult).issues).toHaveLength(1);
  });

  it("reaches zod's ORIGINAL safeParseAsync on the throw path, not the compiled one", async () => {
    // The factory captures the schema's safeParseAsync before installing its
    // own over it, and tags the schema's validate with that capture. Stand a
    // counting wrapper in zod's place to see which one the retry calls.
    const schema = z.object({ a: z.string() }).refine(async () => true);
    const original = Reflect.get(schema, "safeParseAsync") as (input: unknown) => Promise<unknown>;
    const seen: unknown[] = [];
    const wrapper = (input: unknown): Promise<unknown> => {
      seen.push(input);
      return original(input);
    };
    Reflect.set(schema, "safeParseAsync", wrapper);
    const compiled = install(schema);
    const input = { a: "x" };

    expect(Reflect.get(compiled, "safeParseAsync")).not.toBe(wrapper);
    await expect(compiled["~standard"].validate(input)).resolves.toStrictEqual({
      value: { a: "x" },
    });
    expect(seen).toStrictEqual([input]);
  });

  it("survives two exports aliasing one schema object", async () => {
    // The same object compiled twice in one module: the second install captures
    // the FIRST's compiled safeParseAsync as its original, and the retry still
    // has to arrive at zod's.
    const schema = z.object({ a: z.string() }).refine(async (value) => value.a !== "no", "no");
    const plain = z.object({ a: z.string() }).refine(async (value) => value.a !== "no", "no");
    installModule([schema, schema]);

    expect(await settle(schema, { a: "x" })).toBe(await settle(plain, { a: "x" }));
    expect(await settle(schema, { a: "no" })).toBe(await settle(plain, { a: "no" }));
    expect(await settle(schema, { a: 1 })).toBe(await settle(plain, { a: 1 }));
  });

  describe('output: "bag" has no schema to retry through', () => {
    for (const mode of MODES) {
      it(`validates, and rethrows what the validator threw (${mode})`, () => {
        const boom = new Error("boom");
        const [plain, throwing] = installModule(
          [
            z.object({ a: z.string() }),
            z.string().refine(() => {
              throw boom;
            }),
          ],
          { mode, zodCompat: false },
        ) as [Installed, Installed];

        expect(plain.parse.name).toBe("__zp");
        expect(plain["~standard"].validate({ a: "x", extra: 1 })).toStrictEqual({
          value: { a: "x" },
        });
        expect((plain["~standard"].validate({ a: 1 }) as StandardResult).issues).toHaveLength(1);

        const attempt = (): unknown => {
          try {
            return throwing["~standard"].validate("x");
          } catch (error) {
            return error;
          }
        };
        expect(attempt()).toBe(boom);
      });
    }
  });
});
