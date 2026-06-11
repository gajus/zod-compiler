/**
 * Differential Zod-parity tests.
 *
 * Regression suite for a class of bugs where compiled validators silently
 * diverged from Zod: dropped refinements on wrapper types, dropped overwrite
 * checks (.trim()), dropped format validations (jwt, httpUrl protocol), lost
 * regex flags, and lost custom error messages.
 *
 * Every case compiles the schema through the real extract → codegen pipeline
 * with a production-equivalent __zcFin (Zod locale wired, like ZOD_MSG_DECLARATION)
 * and asserts accept/reject parity, output-data parity, and first-message
 * parity against Zod itself.
 */
import { describe, expect, it } from "vitest";
import { ZodRealError, z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { FIN_DECL, FIN_DEFERRED_DECL } from "#src/core/iife.js";
import type { SafeParseResult } from "#src/core/types.js";

const localizedFin = new Function("__zcMsg", "__zcZodError", `${FIN_DECL}; return __zcFin;`)(
  z.config().localeError,
  ZodRealError,
);

interface ZodLikeSchema {
  safeParse: (input: unknown) => {
    success: boolean;
    data?: unknown;
    error?: { issues: { message: string }[] };
  };
}

function compileLikeProduction(
  schema: unknown,
  name = "parity",
): (input: unknown) => SafeParseResult<unknown> {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const generated = generateValidator(ir, name, { refCount: refEntries.length });
  const factory = new Function(
    "__zcMsg",
    "__zcZodError",
    "__zcFin",
    "__rf",
    `${FIN_DEFERRED_DECL}\n${generated.code}\nreturn ${generated.functionDef};`,
  );
  return factory(
    z.config().localeError,
    ZodRealError,
    localizedFin,
    refEntries.map((e) => e.schema),
  ) as (input: unknown) => SafeParseResult<unknown>;
}

/** JSON.stringify that survives BigInt and other non-serializable inputs. */
function describeInput(input: unknown): string {
  try {
    return JSON.stringify(input, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)) ?? String(input);
  } catch {
    return String(input);
  }
}

/** Assert compiled accept/reject, output data, and first message match Zod. */
function expectParity(schema: ZodLikeSchema, inputs: unknown[], name?: string): void {
  const compiled = compileLikeProduction(schema, name);
  for (const input of inputs) {
    const zodResult = schema.safeParse(input);
    const compiledResult = compiled(input);
    expect(compiledResult.success, `accept/reject for ${describeInput(input)}`).toBe(
      zodResult.success,
    );
    if (zodResult.success && compiledResult.success) {
      expect(compiledResult.data, `output data for ${describeInput(input)}`).toEqual(
        zodResult.data,
      );
    }
    if (!zodResult.success && !compiledResult.success) {
      const zodMessage = zodResult.error?.issues[0]?.message;
      const compiledMessage = (compiledResult.error.issues[0] as { message?: string })?.message;
      expect(compiledMessage, `message for ${describeInput(input)}`).toBe(zodMessage);
    }
  }
}

describe("zod parity — refine on types whose extractors ignore checks (fallback)", () => {
  it("nullable.refine rejects what Zod rejects", () => {
    expectParity(
      z
        .string()
        .url()
        .nullable()
        .refine((v) => v !== null, { error: "url is required" }),
      ["https://a.com", null, "not a url"],
    );
  });

  it("optional.refine", () => {
    expectParity(
      z
        .string()
        .optional()
        .refine((v) => v !== undefined, "required"),
      ["x", undefined],
    );
  });

  it("boolean.refine", () => {
    expectParity(
      z.boolean().refine((v) => v === true, "must accept terms"),
      [true, false],
    );
  });

  it("enum.refine", () => {
    expectParity(
      z.enum(["a", "b"]).refine((v) => v === "a", "only a"),
      ["a", "b", "c"],
    );
  });

  it("literal.refine", () => {
    expectParity(
      z.literal("x").refine(() => false, "never"),
      ["x", "y"],
    );
  });

  it("union.refine", () => {
    expectParity(
      z.union([z.string(), z.number()]).refine((v) => typeof v === "string", "strings only"),
      ["x", 42, true],
    );
  });

  it("tuple.refine", () => {
    expectParity(
      z.tuple([z.number(), z.number()]).refine(([a, b]) => a < b, "must ascend"),
      [
        [1, 2],
        [2, 1],
      ],
    );
  });

  it("record.refine", () => {
    expectParity(
      z.record(z.string(), z.string()).refine((v) => Object.keys(v).length > 0, "non-empty"),
      [{ k: "v" }, {}],
    );
  });

  it("map.refine", () => {
    expectParity(
      z.map(z.string(), z.string()).refine((v) => v.size > 0, "non-empty"),
      [new Map([["k", "v"]]), new Map()],
    );
  });

  it("intersection.refine", () => {
    expectParity(
      z
        .intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))
        .refine((v) => v.a !== v.b, "a must differ from b"),
      [
        { a: "x", b: "y" },
        { a: "x", b: "x" },
      ],
    );
  });

  it("default.refine", () => {
    expectParity(
      z
        .string()
        .default("d")
        .refine((v) => v.length > 1, "len>1"),
      ["xx", "x"],
    );
  });

  it("pipe.refine", () => {
    expectParity(
      z
        .string()
        .pipe(z.string())
        .refine((v) => v.length > 1, "len>1"),
      ["xx", "x"],
    );
  });

  it("templateLiteral.refine", () => {
    expectParity(
      z.templateLiteral(["id-", z.number()]).refine(() => false, "never"),
      ["id-5"],
    );
  });

  it("nested field: nullable url with refine inside object", () => {
    expectParity(
      z.object({
        url: z
          .string()
          .url()
          .nullable()
          .refine((v) => v !== null, { error: "url is required" }),
      }),
      [{ url: "https://a.com" }, { url: null }, { url: "not a url" }],
    );
  });
});

describe("zod parity — checks appended to format schemas", () => {
  it("z.email().min() keeps the length check", () => {
    expectParity(z.email().min(20, "email too short"), ["a@b.com", "long.address@example.com"]);
  });

  it("z.email().refine() keeps the refinement", () => {
    expectParity(
      z.email().refine((v) => v.endsWith(".com"), "must be .com"),
      ["a@b.com", "a@b.org"],
    );
  });

  it("z.int().refine() keeps the refinement", () => {
    expectParity(
      z.int().refine((v) => v % 2 === 0, "must be even"),
      [2, 3],
    );
  });
});

describe("zod parity — format validations that previously compiled to nothing", () => {
  it("z.jwt() rejects non-JWTs (falls back)", () => {
    expectParity(z.jwt(), [
      "not-a-jwt",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig",
    ]);
  });

  it("z.httpUrl() rejects non-http protocols", () => {
    expectParity(z.httpUrl(), [
      "https://example.com",
      "http://example.com",
      "ftp://example.com",
      "not a url",
    ]);
  });

  it("z.emoji() keeps its unicode regex flags", () => {
    expectParity(z.emoji(), ["😀", "x", "👍🏽"]);
  });

  it("z.int64() enforces its range", () => {
    expectParity(z.int64(), [1n, 99999999999999999999n, -99999999999999999999n]);
  });

  it("z.set().size() enforces exact size", () => {
    expectParity(z.set(z.string()).size(2), [
      new Set(["a", "b"]),
      new Set(["a"]),
      new Set(["a", "b", "c"]),
    ]);
  });
});

describe("zod parity — overwrite checks (.trim, .toLowerCase) compile with mutation", () => {
  it(".trim() trims the output", () => {
    expectParity(z.string().trim(), ["  padded  ", "clean"]);
  });

  it(".toLowerCase() rewrites the output", () => {
    expectParity(z.string().toLowerCase(), ["MiXeD", "lower"]);
  });

  it("check order around .trim() is preserved (min before trim sees raw value)", () => {
    // .min(5) runs on the untrimmed value, then trim shrinks it
    expectParity(z.string().min(5, "too short").trim(), ["  x  ", "abcdef", "abc"]);
  });

  it("check order after .trim() sees the trimmed value", () => {
    expectParity(z.string().trim().min(5, "too short"), ["  x  ", "  abcdef  ", "abcdef"]);
  });

  it(".trim() inside an object field mutates only that field", () => {
    expectParity(z.object({ name: z.string().trim(), keep: z.string() }), [
      { name: "  pad  ", keep: "  raw  " },
    ]);
  });

  it("z.url() trims its output like Zod", () => {
    expectParity(z.string().url(), [" https://a.com ", "https://a.com", "nope"]);
  });

  it("mutating element schemas inside Set/Map rebuild the collection", () => {
    expectParity(z.set(z.string().trim()), [new Set(["  a  ", "b"])]);
    expectParity(z.map(z.string(), z.string().trim()), [new Map([["k", "  v  "]])]);
  });
});

describe("zod parity — custom error messages", () => {
  it("object refine with { error } keeps the message through __zcFin", () => {
    expectParity(
      z.object({ description: z.string() }).refine((v) => v.description.trim().length > 0, {
        error: "Company description is required",
      }),
      [{ description: "" }, { description: "ok" }],
    );
  });

  it("refine without params matches Zod's locale default", () => {
    expectParity(
      z.string().refine((v) => v.length > 2),
      ["x"],
    );
  });

  it("min/max/email custom messages survive", () => {
    expectParity(z.string().min(3, "Name too short"), ["x"]);
    expectParity(z.string().max(2, "Name too long"), ["xxx"]);
    expectParity(z.string().email("Bad email"), ["nope"]);
  });

  it("schema-level { error } applies to node-level issues only (Zod precedence)", () => {
    expectParity(z.string({ error: "must be a string" }), [42]);
    // Zod resolves check issues against the CHECK's error map, not the
    // schema's — min(3) failure gets the locale default, not "bad name".
    expectParity(z.string({ error: "bad name" }).min(3), ["x", 42]);
    expectParity(z.enum(["a", "b"], { error: "pick a or b" }), ["c"]);
    expectParity(z.union([z.string(), z.number()], { error: "string or number" }), [true]);
    expectParity(z.tuple([z.string()], { error: "exactly one" }), [[], ["a", "b"]]);
  });

  it("dynamic error maps fall back so messages stay exact", () => {
    expectParity(
      z.string().refine((v) => v.length > 2, {
        error: (issue) => `got ${String((issue.input as string).length)} chars`,
      }),
      ["x"],
    );
    expectParity(
      z.string({
        error: (issue) => (issue.input === undefined ? "Required" : "Not a string"),
      }),
      [undefined, 42],
    );
  });

  it("fallback sub-schema messages are not clobbered by the locale map", () => {
    // superRefine always falls back; its custom message must survive __zcFin.
    const schema = z.object({
      slug: z.string().superRefine((value, ctx) => {
        if (value.includes(" ")) {
          ctx.addIssue({ code: "custom", message: "slug cannot contain spaces" });
        }
      }),
    });
    expectParity(schema, [{ slug: "has space" }, { slug: "clean" }]);
  });
});

describe("zod parity — tuple shape semantics", () => {
  it("short tuples report per-item invalid_type, never too_small", () => {
    expectParity(z.tuple([z.string(), z.number()]), [[], ["a"], ["a", 1]]);
  });

  it("trailing optional items are omittable", () => {
    expectParity(z.tuple([z.string(), z.string().optional()]), [["a"], ["a", "b"], [], ["a", 1]]);
  });

  it("too-long tuples use the schema-level error", () => {
    expectParity(z.tuple([z.string()], { error: "exactly one" }), [["a", "b"]]);
  });

  it("rest tuples accept the base length", () => {
    expectParity(z.tuple([z.string()]).rest(z.number()), [["a"], ["a", 1, 2], ["a", "b"]]);
  });
});

describe("zod parity — object unknown-key policies", () => {
  it("z.strictObject rejects unknown keys (compiled)", () => {
    expectParity(z.strictObject({ a: z.string(), b: z.number().optional() }), [
      { a: "x" },
      { a: "x", b: 1 },
      { a: "x", extra: 1 },
      { a: "x", e1: 1, e2: 2, e3: 3 },
      { a: 1, extra: true }, // property issue + unrecognized_keys ordering
      {},
      [],
      null,
    ]);
  });

  it("z.object().strict() and .catchall(z.never()) compile identically", () => {
    expectParity(z.object({ a: z.string() }).strict(), [{ a: "x" }, { a: "x", b: 1 }]);
    expectParity(z.object({ a: z.string() }).catchall(z.never()), [{ a: "x" }, { a: "x", b: 1 }]);
  });

  it("empty strict object rejects every key", () => {
    expectParity(z.strictObject({}), [{}, { any: 1 }]);
  });

  it("wide strict object uses Set membership (>5 keys)", () => {
    const wide = z.strictObject({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
      f: z.string(),
      g: z.string(),
    });
    const ok = Object.fromEntries(Array.from("abcdefg", (k) => [k, "v"]));
    expectParity(wide, [ok, { ...ok, zz: 1 }, { ...ok, _x: 1, _y: 2 }]);
  });

  it("nested strict objects report at the nested path", () => {
    expectParity(z.object({ inner: z.strictObject({ x: z.number() }) }), [
      { inner: { x: 1 } },
      { inner: { x: 1, y: 2 } },
    ]);
  });

  it("strict object inside a discriminated union", () => {
    const du = z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("a"), v: z.string() }),
      z.strictObject({ kind: z.literal("b"), n: z.number() }),
    ]);
    expectParity(du, [
      { kind: "a", v: "x" },
      { kind: "b", n: 1 },
      { kind: "a", v: "x", extra: 1 },
      { kind: "c" },
    ]);
  });

  it("z.object().catchall(schema) validates unknown keys (falls back)", () => {
    expectParity(z.object({ a: z.string() }).catchall(z.number()), [
      { a: "x", extra: 1 },
      { a: "x", extra: "not a number" },
    ]);
  });

  it("z.looseObject compiles and passes unknown keys through", () => {
    expectParity(z.looseObject({ a: z.string() }), [{ a: "x", extra: 1 }]);
  });
});
