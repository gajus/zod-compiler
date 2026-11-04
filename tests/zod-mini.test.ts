/**
 * `zod/mini` schemas (issue #22).
 *
 * Mini shares every schema internal the compiler reads with classic zod, so
 * one IR and one validator serve both — but a failed parse is where they part.
 * Mini's methods call zod/v4/core's parse functions, which build core's
 * `$ZodError`; classic's build `ZodError`. Same issues, different class:
 * `name`, `instanceof z.ZodError`, classic's `.flatten()`/`.format()`. A
 * compiled Mini schema answered with classic's class, and every parity check
 * passed, because none of them looked past the issues. The harness now compares
 * the class on every failure (see errorClassSignature), so the battery below
 * pins it for Mini across both codegen modes, and every classic parity suite
 * pins it for classic.
 *
 * The other half of the issue was the TYPE: `compile()` and `jit()` were
 * constrained to classic's `ZodType`, so a Mini schema did not type-check at
 * all. That is checked by compiling tests/fixtures/zod-mini-types.ts.
 */
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import * as zm from "zod/mini";
import * as core from "zod/v4/core";
import { generateValidator } from "#src/core/codegen/index.js";
import { zodErrorClassOf } from "#src/core/extract/error-class.js";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import { compile, isCompiledSchema } from "#src/index.js";
import { jit } from "#src/jit.js";
import {
  errorClassSignature,
  expectLeanFileParity,
  expectLeanParity,
  expectParity,
  type ZodLikeSchema,
} from "./parity-harness.js";

const CORE_ERROR = { name: "$ZodError", traits: ["$ZodError"] };
const CLASSIC_ERROR = { name: "ZodError", traits: ["$ZodError", "ZodError"] };

describe("zodErrorClassOf", () => {
  it("reads the class off the schema's flavor", () => {
    expect(zodErrorClassOf(z.object({}))).toBe("ZodError");
    expect(zodErrorClassOf(z.email())).toBe("ZodError");
    expect(zodErrorClassOf(zm.object({}))).toBe("$ZodError");
    expect(zodErrorClassOf(zm.email())).toBe("$ZodError");
    // Built straight from core: no parse methods of its own, and core's
    // `parse()` fails with core's class.
    expect(zodErrorClassOf(new core.$ZodString({ type: "string" }))).toBe("$ZodError");
  });

  it("keeps the classic class for anything it cannot read", () => {
    expect(zodErrorClassOf(undefined)).toBe("ZodError");
    expect(zodErrorClassOf({})).toBe("ZodError");
    expect(zodErrorClassOf({ _zod: { traits: "not a set" } })).toBe("ZodError");
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      },
    );
    expect(zodErrorClassOf(hostile)).toBe("ZodError");
  });

  it("follows the ROOT schema, whose methods the validator replaces", () => {
    // Each flavor's own parse decides the class, whatever it holds.
    expect(zodErrorClassOf(zm.object({ a: z.string() }))).toBe("$ZodError");
    expect(zodErrorClassOf(z.object({ a: zm.string() }))).toBe("ZodError");
  });
});

interface Case {
  label: string;
  schema: () => ZodLikeSchema;
  inputs: unknown[];
}

const Tree = zm.object({
  value: zm.number(),
  get children() {
    return zm.array(Tree);
  },
});

const CASES: Case[] = [
  {
    label: "object with checked fields",
    schema: () =>
      zm.object({
        name: zm.string().check(zm.minLength(2, "too short"), zm.maxLength(8)),
        email: zm.email(),
        age: zm.optional(zm.int().check(zm.gte(0))),
        tags: zm.array(zm.string()).check(zm.minLength(1)),
      }),
    inputs: [
      { name: "Ada", email: "ada@example.com", tags: ["x"] },
      { name: "Ada", email: "ada@example.com", age: 36, tags: ["x", "y"] },
      { name: "A", email: "nope", age: -1.5, tags: [] },
      { name: 1, email: null, tags: [2] },
      {},
      null,
      "object",
    ],
  },
  {
    label: "strict, loose and catchall objects",
    schema: () =>
      zm.object({
        strict: zm.strictObject({ a: zm.string() }),
        loose: zm.looseObject({ a: zm.string() }),
        rest: zm.catchall(zm.object({ a: zm.string() }), zm.number()),
      }),
    inputs: [
      { strict: { a: "x" }, loose: { a: "x", b: 1 }, rest: { a: "x", n: 1 } },
      { strict: { a: "x", extra: 1 }, loose: { a: 1 }, rest: { a: "x", n: "1" } },
      { strict: {}, loose: {}, rest: {} },
    ],
  },
  {
    label: "primitives and formats",
    schema: () =>
      zm.tuple([
        zm.number().check(zm.multipleOf(5), zm.lt(100)),
        zm.uuid(),
        zm.url(),
        zm.ipv4(),
        zm.iso.datetime(),
        zm.boolean(),
        zm.bigint(),
        zm.date(),
      ]),
    inputs: [
      [
        10,
        "123e4567-e89b-12d3-a456-426614174000",
        "https://example.com",
        "10.0.0.1",
        "2024-01-01T00:00:00Z",
        true,
        1n,
        new Date(0),
      ],
      [7, "not-a-uuid", "nope", "999.0.0.1", "yesterday", "true", 1, "2024"],
      [105, "", "", "", "", 0, 0n, new Date(Number.NaN)],
    ],
  },
  {
    label: "tuple rest, record, set and map",
    schema: () =>
      zm.object({
        t: zm.tuple([zm.string(), zm.number()], zm.boolean()),
        r: zm.record(zm.string(), zm.number()),
        s: zm.set(zm.string()),
        m: zm.map(zm.string(), zm.number()),
      }),
    inputs: [
      { t: ["a", 1, true, false], r: { x: 1 }, s: new Set(["a"]), m: new Map([["a", 1]]) },
      { t: ["a"], r: { x: "1" }, s: new Set([1]), m: new Map([[1, "a"]]) },
      { t: [1, "a", "no"], r: [], s: [], m: {} },
    ],
  },
  {
    label: "unions, enums and literals",
    schema: () =>
      zm.object({
        u: zm.union([zm.string(), zm.number()]),
        d: zm.discriminatedUnion("kind", [
          zm.object({ kind: zm.literal("a"), a: zm.string() }),
          zm.object({ kind: zm.literal("b"), b: zm.number() }),
        ]),
        e: zm.enum(["x", "y"]),
        i: zm.intersection(zm.object({ a: zm.string() }), zm.object({ b: zm.number() })),
      }),
    inputs: [
      { u: "s", d: { kind: "a", a: "x" }, e: "x", i: { a: "x", b: 1 } },
      { u: 1, d: { kind: "b", b: 2 }, e: "y", i: { a: "x", b: 1, c: true } },
      { u: true, d: { kind: "c" }, e: "z", i: { a: 1 } },
      { u: null, d: { kind: "a", a: 1 }, e: undefined, i: null },
    ],
  },
  {
    label: "optional, nullable, default, prefault and catch",
    schema: () =>
      zm.object({
        o: zm.optional(zm.string()),
        n: zm.nullable(zm.number()),
        ns: zm.nullish(zm.boolean()),
        d: zm._default(zm.number(), 5),
        p: zm.prefault(zm.string().check(zm.minLength(2)), "ok"),
        // oxlint-disable-next-line promise/valid-params -- false positive: zod/mini's catch(), not Promise#catch
        c: zm.catch(zm.number(), 0),
      }),
    inputs: [
      { n: null },
      { o: "x", n: 1, ns: null, d: 2, p: "xyz", c: 3 },
      { o: 1, n: undefined, ns: "x", d: "2", p: "x", c: "bad" },
      {},
    ],
  },
  {
    label: "transforms, overwrites and refinements",
    schema: () =>
      zm.object({
        len: zm.pipe(
          zm.string(),
          zm.transform((s: string) => s.length),
        ),
        norm: zm.string().check(zm.trim(), zm.toLowerCase()),
        x: zm.string().check(zm.refine((s: string) => s.startsWith("x"), "must start with x")),
        sr: zm.number().check(
          zm.superRefine((v: number, ctx) => {
            if (v % 2 !== 0) ctx.addIssue({ code: "custom", message: "must be even" });
          }),
        ),
      }),
    inputs: [
      { len: "hello", norm: "  MiXed ", x: "xyz", sr: 2 },
      { len: 3, norm: 4, x: "abc", sr: 3 },
      { len: "", norm: "", x: "", sr: "2" },
    ],
  },
  {
    label: "custom messages and stringbool",
    schema: () =>
      zm.object({
        s: zm.string({ error: "need a string" }),
        b: zm.stringbool(),
      }),
    inputs: [{ s: "x", b: "yes" }, { s: 1, b: "maybe" }, { b: 1 }],
  },
  {
    label: "recursion through a getter",
    schema: () => Tree,
    inputs: [
      { value: 1, children: [{ value: 2, children: [] }] },
      { value: 1, children: [{ value: "2", children: [{ value: 3 }] }] },
      { value: 1 },
    ],
  },
];

describe("compiled zod/mini schemas match plain zod/mini", () => {
  for (const { label, schema, inputs } of CASES) {
    it(`inline: ${label}`, () => {
      expectParity(schema(), inputs, "mini");
    });

    it(`lean: ${label}`, () => {
      expectLeanParity(schema(), inputs, "mini");
    });
  }

  it("is not parity by delegation: each validator calls only the $ZodError finalizers", () => {
    // Every case above compiles rather than handing the whole parse back to
    // zod, whose result would match trivially. And the classic finalizers are
    // never called, so a Mini-only bundle has no use for classic's class.
    for (const { label, schema } of CASES) {
      const s = schema();
      const refs: RefEntry[] = [];
      const ir = extractSchema(s, refs);
      expect(ir.type, label).not.toBe("fallback");
      const { code, functionDef, usedHelpers } = generateValidator(ir, "mini", {
        refCount: refs.length,
        errorClass: zodErrorClassOf(s),
      });
      const source = `${code}\n${functionDef}`;
      expect(source, label).toMatch(/__zcFinD?C\(/);
      expect(source, label).not.toMatch(/__zcFinD?\(/);
      expect(
        [...usedHelpers].filter((h) => h === "__zcFin" || h === "__zcFinD"),
        label,
      ).toEqual([]);
    }
  });

  it("a file mixing classic and Mini exports keeps each export's own class", () => {
    // One lean module, both finalizer pairs, and a shape shared across the two
    // flavors (shared slow walks never finalize, so sharing stays sound).
    const shape = () => ({ id: zm.string(), n: zm.number() });
    const inputs = [{ id: "a", n: 1 }, { id: 1 }, null];
    expectLeanFileParity([
      { exportName: "Mini", schema: zm.object(shape()), inputs },
      { exportName: "MiniAgain", schema: zm.object(shape()), inputs },
      { exportName: "Classic", schema: z.object({ id: z.string(), n: z.number() }), inputs },
      { exportName: "MiniInClassic", schema: z.object({ inner: zm.object(shape()) }), inputs },
      {
        exportName: "ClassicInMini",
        schema: zm.object({ inner: z.object({ id: z.string() }) }),
        inputs,
      },
    ]);
  });
});

/** Settle a promise into its error, for comparing rejection classes. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("methods jit() installs on a zod/mini schema", () => {
  const make = () => zm.object({ name: zm.string().check(zm.minLength(2)), age: zm.number() });
  const bad = { name: "A", age: "1" };

  it("fail with core's $ZodError, as the schema's own methods do", async () => {
    const plain = make();
    const compiled = jit(make(), { eager: true });
    expect(Object.getOwnPropertyDescriptor(compiled, "safeParse")?.value?.name).toBe(
      "safeParse_jit",
    );

    const fromSafeParse = compiled.safeParse(bad).error;
    expect(errorClassSignature(fromSafeParse)).toStrictEqual(CORE_ERROR);
    expect(errorClassSignature(plain.safeParse(bad).error)).toStrictEqual(CORE_ERROR);
    expect(fromSafeParse).toBeInstanceOf(core.$ZodError);
    expect(fromSafeParse instanceof z.ZodError).toBe(false);
    expect((fromSafeParse as unknown as Record<string, unknown>)["flatten"]).toBeUndefined();
    expect(fromSafeParse?.issues).toStrictEqual(plain.safeParse(bad).error?.issues);

    let thrown: unknown;
    try {
      compiled.parse(bad);
    } catch (error) {
      thrown = error;
    }
    expect(errorClassSignature(thrown)).toStrictEqual(CORE_ERROR);
    expect(errorClassSignature(await rejection(compiled.parseAsync(bad)))).toStrictEqual(
      CORE_ERROR,
    );
    const async = await compiled.safeParseAsync(bad);
    expect(errorClassSignature(async.error)).toStrictEqual(CORE_ERROR);

    const standard = await compiled["~standard"].validate(bad);
    expect(standard).toStrictEqual(await plain["~standard"].validate(bad));
    expect(compiled.is(bad)).toBe(false);
    expect(compiled.is({ name: "Ada", age: 36 })).toBe(true);
  });

  it("leave a classic schema failing with classic's ZodError", () => {
    const compiled = jit(z.object({ name: z.string() }), { eager: true });
    const error = compiled.safeParse({}).error;
    expect(errorClassSignature(error)).toStrictEqual(CLASSIC_ERROR);
    expect(error).toBeInstanceOf(z.ZodError);
  });

  it("follow the root schema's flavor, not a nested one's", () => {
    const miniRoot = jit(zm.object({ inner: z.object({ id: z.string() }) }), { eager: true });
    expect(errorClassSignature(miniRoot.safeParse({ inner: {} }).error)).toStrictEqual(CORE_ERROR);
    const classicRoot = jit(z.object({ inner: zm.object({ id: zm.string() }) }), { eager: true });
    expect(errorClassSignature(classicRoot.safeParse({ inner: {} }).error)).toStrictEqual(
      CLASSIC_ERROR,
    );
  });

  it("compile on first use, like a classic schema", () => {
    const schema = jit(make());
    expect(Object.getOwnPropertyDescriptor(schema, "safeParse")?.value).toBeUndefined();
    expect(errorClassSignature(schema.safeParse(bad).error)).toStrictEqual(CORE_ERROR);
    expect(Object.getOwnPropertyDescriptor(schema, "safeParse")?.value?.name).toBe("safeParse_jit");
  });
});

describe("compile() on a zod/mini schema before any build", () => {
  it("returns the schema itself, marked, with a working .is()", () => {
    const schema = zm.object({ a: zm.string() });
    const compiled = compile(schema);
    expect(compiled).toBe(schema);
    expect(isCompiledSchema(compiled)).toBe(true);
    expect(compiled.is({ a: "x" })).toBe(true);
    expect(compiled.is({ a: 1 })).toBe(false);
    expect(errorClassSignature(compiled.safeParse({}).error)).toStrictEqual(CORE_ERROR);
  });
});

describe("types", () => {
  it("compile() and jit() accept zod/mini schemas, inferring their output", () => {
    // tests/tsconfig.json sets `noCheck`, so this file's own types are never
    // checked. The fixture is, under the repo's own compiler options. Its
    // `@ts-expect-error` lines make the rejections part of the assertion.
    const root = `${import.meta.dirname}/..`;
    const fixture = `${import.meta.dirname}/fixtures/zod-mini-types.ts`;
    const { config } = ts.readConfigFile(`${root}/tsconfig.base.json`, (file) =>
      ts.sys.readFile(file),
    );
    const { options } = ts.parseJsonConfigFileContent(config, ts.sys, root);
    const program = ts.createProgram([fixture], { ...options, noEmit: true });
    const source = program.getSourceFile(fixture);
    expect(source, "fixture must be part of the program").toBeDefined();
    const diagnostics = [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ].map((d) => {
      const line =
        d.file && d.start !== undefined
          ? d.file.getLineAndCharacterOfPosition(d.start).line + 1
          : 0;
      return `line ${line}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
    expect(diagnostics).toStrictEqual([]);
  }, 60_000);
});
