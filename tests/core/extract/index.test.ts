import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import type {
  AnyIR,
  ArrayIR,
  BooleanIR,
  DefaultIR,
  DiscriminatedUnionIR,
  EnumIR,
  FallbackIR,
  IntersectionIR,
  LiteralIR,
  NanIR,
  NeverIR,
  NullableIR,
  NullIR,
  NumberIR,
  ObjectIR,
  OptionalIR,
  RecordIR,
  StringIR,
  SymbolIR,
  TransformEffectIR,
  TupleIR,
  UndefinedIR,
  UnionIR,
  UnknownIR,
  VoidIR,
} from "#src/core/types.js";

// ─── Primitive Types ────────────────────────────────────────────────────────

describe("extractSchema — primitives", () => {
  it("extracts a plain string schema", () => {
    const ir = extractSchema(z.string());
    expect(ir).toEqual<StringIR>({
      type: "string",
      checks: [],
    });
  });

  it("extracts a plain number schema", () => {
    const ir = extractSchema(z.number());
    expect(ir).toEqual<NumberIR>({
      type: "number",
      checks: [],
    });
  });

  it("extracts a boolean schema", () => {
    const ir = extractSchema(z.boolean());
    expect(ir).toEqual<BooleanIR>({
      type: "boolean",
    });
  });

  it("extracts a null schema", () => {
    const ir = extractSchema(z.null());
    expect(ir).toEqual<NullIR>({
      type: "null",
    });
  });

  it("extracts an undefined schema", () => {
    const ir = extractSchema(z.undefined());
    expect(ir).toEqual<UndefinedIR>({
      type: "undefined",
    });
  });

  it("extracts a symbol schema", () => {
    const ir = extractSchema(z.symbol());
    expect(ir).toEqual<SymbolIR>({
      type: "symbol",
    });
  });

  it("extracts a void schema", () => {
    const ir = extractSchema(z.void());
    expect(ir).toEqual<VoidIR>({
      type: "void",
    });
  });

  it("extracts a nan schema", () => {
    const ir = extractSchema(z.nan());
    expect(ir).toEqual<NanIR>({
      type: "nan",
    });
  });

  it("extracts a never schema", () => {
    const ir = extractSchema(z.never());
    expect(ir).toEqual<NeverIR>({
      type: "never",
    });
  });
});

// ─── Object Schemas ─────────────────────────────────────────────────────────

describe("extractSchema — object", () => {
  it("extracts a simple object schema", () => {
    const ir = extractSchema(z.object({ name: z.string() })) as ObjectIR;
    expect(ir.type).toBe("object");
    expect(ir.properties).toHaveProperty("name");
    expect(ir.properties["name"]?.type).toBe("string");
  });

  it("extracts an object with multiple properties", () => {
    const ir = extractSchema(
      z.object({
        name: z.string().min(1),
        age: z.number().int(),
        active: z.boolean(),
      }),
    ) as ObjectIR;
    expect(ir.type).toBe("object");
    expect(Object.keys(ir.properties)).toEqual(["name", "age", "active"]);
    expect(ir.properties["name"]?.type).toBe("string");
    expect(ir.properties["age"]?.type).toBe("number");
    expect(ir.properties["active"]?.type).toBe("boolean");
  });

  it("preserves checks on nested properties", () => {
    const ir = extractSchema(z.object({ name: z.string().min(3).max(50) })) as ObjectIR;
    const nameIR = ir.properties["name"] as StringIR;
    expect(nameIR.checks).toContainEqual({ kind: "min_length", minimum: 3 });
    expect(nameIR.checks).toContainEqual({ kind: "max_length", maximum: 50 });
  });

  it("extracts nested object schemas", () => {
    const ir = extractSchema(
      z.object({
        user: z.object({
          name: z.string(),
          age: z.number(),
        }),
      }),
    ) as ObjectIR;
    expect(ir.properties["user"]?.type).toBe("object");
    const userIR = ir.properties["user"] as ObjectIR;
    expect(userIR.properties["name"]?.type).toBe("string");
    expect(userIR.properties["age"]?.type).toBe("number");
  });

  it("extracts empty object schema", () => {
    const ir = extractSchema(z.object({})) as ObjectIR;
    expect(ir.type).toBe("object");
    expect(ir.properties).toEqual({});
  });

  it("extracts object with optional properties", () => {
    const ir = extractSchema(
      z.object({
        required: z.string(),
        optional: z.string().optional(),
      }),
    ) as ObjectIR;
    expect(ir.properties["required"]?.type).toBe("string");
    expect(ir.properties["optional"]?.type).toBe("optional");
    const optIR = ir.properties["optional"] as OptionalIR;
    expect(optIR.inner.type).toBe("string");
  });
});

// ─── Array Schemas ──────────────────────────────────────────────────────────

describe("extractSchema — array", () => {
  it("extracts a basic array schema", () => {
    const ir = extractSchema(z.array(z.string())) as ArrayIR;
    expect(ir.type).toBe("array");
    expect(ir.element.type).toBe("string");
    expect(ir.checks).toEqual([]);
  });

  it("extracts array with min length check", () => {
    const ir = extractSchema(z.array(z.number()).min(1)) as ArrayIR;
    expect(ir.checks).toContainEqual({ kind: "min_length", minimum: 1 });
  });

  it("extracts array with max length check", () => {
    const ir = extractSchema(z.array(z.number()).max(10)) as ArrayIR;
    expect(ir.checks).toContainEqual({ kind: "max_length", maximum: 10 });
  });

  it("extracts array with length equals check", () => {
    const ir = extractSchema(z.array(z.string()).length(5)) as ArrayIR;
    expect(ir.checks).toContainEqual({ kind: "length_equals", length: 5 });
  });

  it("extracts array of objects", () => {
    const ir = extractSchema(z.array(z.object({ id: z.number(), name: z.string() }))) as ArrayIR;
    expect(ir.element.type).toBe("object");
    const elemIR = ir.element as ObjectIR;
    expect(elemIR.properties["id"]?.type).toBe("number");
    expect(elemIR.properties["name"]?.type).toBe("string");
  });

  it("extracts nested arrays", () => {
    const ir = extractSchema(z.array(z.array(z.string()))) as ArrayIR;
    expect(ir.element.type).toBe("array");
    const innerIR = ir.element as ArrayIR;
    expect(innerIR.element.type).toBe("string");
  });
});

// ─── Enum Schemas ───────────────────────────────────────────────────────────

describe("extractSchema — enum", () => {
  it("extracts enum values", () => {
    const ir = extractSchema(z.enum(["admin", "user", "guest"])) as EnumIR;
    expect(ir.type).toBe("enum");
    expect(ir.values).toEqual(["admin", "user", "guest"]);
  });

  it("extracts single-value enum", () => {
    const ir = extractSchema(z.enum(["only"])) as EnumIR;
    expect(ir.type).toBe("enum");
    expect(ir.values).toEqual(["only"]);
  });
});

// ─── Literal Schemas ────────────────────────────────────────────────────────

describe("extractSchema — literal", () => {
  it("extracts string literal", () => {
    const ir = extractSchema(z.literal("hello")) as LiteralIR;
    expect(ir.type).toBe("literal");
    expect(ir.values).toEqual(["hello"]);
  });

  it("extracts number literal", () => {
    const ir = extractSchema(z.literal(42)) as LiteralIR;
    expect(ir.type).toBe("literal");
    expect(ir.values).toEqual([42]);
  });

  it("extracts boolean literal", () => {
    const ir = extractSchema(z.literal(true)) as LiteralIR;
    expect(ir.type).toBe("literal");
    expect(ir.values).toEqual([true]);
  });

  it("extracts null literal", () => {
    const ir = extractSchema(z.literal(null)) as LiteralIR;
    expect(ir.type).toBe("literal");
    expect(ir.values).toEqual([null]);
  });
});

// ─── Optional / Nullable Wrappers ───────────────────────────────────────────

describe("extractSchema — optional", () => {
  it("extracts optional string", () => {
    const ir = extractSchema(z.string().optional()) as OptionalIR;
    expect(ir.type).toBe("optional");
    expect(ir.inner.type).toBe("string");
  });

  it("extracts z.optional() wrapper", () => {
    const ir = extractSchema(z.optional(z.number())) as OptionalIR;
    expect(ir.type).toBe("optional");
    expect(ir.inner.type).toBe("number");
  });

  it("preserves inner checks through optional", () => {
    const ir = extractSchema(z.string().min(3).optional()) as OptionalIR;
    expect(ir.inner.type).toBe("string");
    const innerIR = ir.inner as StringIR;
    expect(innerIR.checks).toContainEqual({ kind: "min_length", minimum: 3 });
  });
});

describe("extractSchema — nullable", () => {
  it("extracts nullable string", () => {
    const ir = extractSchema(z.string().nullable()) as NullableIR;
    expect(ir.type).toBe("nullable");
    expect(ir.inner.type).toBe("string");
  });

  it("extracts z.nullable() wrapper", () => {
    const ir = extractSchema(z.nullable(z.number())) as NullableIR;
    expect(ir.type).toBe("nullable");
    expect(ir.inner.type).toBe("number");
  });

  it("preserves inner checks through nullable", () => {
    const ir = extractSchema(z.number().min(0).nullable()) as NullableIR;
    expect(ir.inner.type).toBe("number");
    const innerIR = ir.inner as NumberIR;
    expect(innerIR.checks).toContainEqual({ kind: "greater_than", value: 0, inclusive: true });
  });
});

describe("extractSchema — optional + nullable combined", () => {
  it("extracts optional nullable string", () => {
    const ir = extractSchema(z.string().nullable().optional()) as OptionalIR;
    expect(ir.type).toBe("optional");
    expect(ir.inner.type).toBe("nullable");
    const nullableIR = ir.inner as NullableIR;
    expect(nullableIR.inner.type).toBe("string");
  });

  it("extracts nullable optional string", () => {
    const ir = extractSchema(z.string().optional().nullable()) as NullableIR;
    expect(ir.type).toBe("nullable");
    expect(ir.inner.type).toBe("optional");
    const optIR = ir.inner as OptionalIR;
    expect(optIR.inner.type).toBe("string");
  });
});

// ─── any / unknown ─────────────────────────────────────────────────────────

describe("extractSchema — any", () => {
  it("extracts z.any()", () => {
    const ir = extractSchema(z.any());
    expect(ir).toEqual<AnyIR>({ type: "any" });
  });
});

describe("extractSchema — unknown", () => {
  it("extracts z.unknown()", () => {
    const ir = extractSchema(z.unknown());
    expect(ir).toEqual<UnknownIR>({ type: "unknown" });
  });
});

// ─── readonly ──────────────────────────────────────────────────────────────

describe("extractSchema — readonly", () => {
  it("falls back for readonly string (Zod freezes its output)", () => {
    const ir = extractSchema(z.string().readonly());
    expect(ir.type).toBe("fallback");
  });

  it("falls back for readonly object (freezing compiled output would freeze caller input)", () => {
    const ir = extractSchema(z.object({ name: z.string() }).readonly());
    expect(ir.type).toBe("fallback");
  });
});

// ─── tuple ─────────────────────────────────────────────────────────────────

describe("extractSchema — tuple", () => {
  it("extracts basic tuple", () => {
    const ir = extractSchema(z.tuple([z.string(), z.number()])) as TupleIR;
    expect(ir.type).toBe("tuple");
    expect(ir.items).toHaveLength(2);
    expect(ir.items[0]?.type).toBe("string");
    expect(ir.items[1]?.type).toBe("number");
    expect(ir.rest).toBeNull();
  });

  it("extracts tuple with rest", () => {
    const ir = extractSchema(z.tuple([z.string()]).rest(z.number())) as TupleIR;
    expect(ir.items).toHaveLength(1);
    expect(ir.items[0]?.type).toBe("string");
    expect(ir.rest).not.toBeNull();
    expect(ir.rest?.type).toBe("number");
  });

  it("extracts empty tuple", () => {
    const ir = extractSchema(z.tuple([])) as TupleIR;
    expect(ir.items).toHaveLength(0);
    expect(ir.rest).toBeNull();
  });
});

// ─── record ────────────────────────────────────────────────────────────────

describe("extractSchema — record", () => {
  it("extracts string key record", () => {
    const ir = extractSchema(z.record(z.string(), z.number())) as RecordIR;
    expect(ir.type).toBe("record");
    expect(ir.keyType.type).toBe("string");
    expect(ir.valueType.type).toBe("number");
  });

  it("falls back for enum key record (Zod requires exhaustive keys)", () => {
    const ir = extractSchema(z.record(z.enum(["a", "b"]), z.string()));
    expect(ir.type).toBe("fallback");
  });

  it("extracts partialRecord with enum keys (keys optional — compiles)", () => {
    const ir = extractSchema(z.partialRecord(z.enum(["a", "b"]), z.string())) as RecordIR;
    expect(ir.type).toBe("record");
    expect(ir.keyType.type).toBe("enum");
    expect(ir.valueType.type).toBe("string");
  });
});

// ─── intersection ──────────────────────────────────────────────────────────

describe("extractSchema — intersection", () => {
  it("extracts object intersection", () => {
    const ir = extractSchema(
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
    ) as IntersectionIR;
    expect(ir.type).toBe("intersection");
    expect(ir.left.type).toBe("object");
    expect(ir.right.type).toBe("object");
  });

  it("extracts .and() syntax", () => {
    const ir = extractSchema(
      z.object({ a: z.string() }).and(z.object({ b: z.number() })),
    ) as IntersectionIR;
    expect(ir.type).toBe("intersection");
  });
});

// ─── Fallback Detection ─────────────────────────────────────────────────────

describe("extractSchema — effect compilation (zero-capture transform/refine)", () => {
  it("returns EffectIR for zero-capture transform", () => {
    const ir = extractSchema(z.string().transform((v) => parseInt(v, 10)));
    expect(ir.type).toBe("effect");
    const effectIR = ir as TransformEffectIR;
    expect(effectIR.effectKind).toBe("transform");
    expect(effectIR.source).toContain("parseInt");
    expect(effectIR.inner.type).toBe("string");
  });

  it("returns StringIR with refine_effect check for zero-capture refine", () => {
    const ir = extractSchema(z.string().refine((v) => v.startsWith("a")));
    expect(ir.type).toBe("string");
    const strIR = ir as StringIR;
    expect(strIR.checks).toContainEqual(expect.objectContaining({ kind: "refine_effect" }));
  });

  it("returns fallback for superRefine (ctx param prevents compilation)", () => {
    const ir = extractSchema(
      z.string().superRefine((val, ctx) => {
        if (val.length < 3) {
          ctx.addIssue({ code: "custom", message: "too short" });
        }
      }),
    );
    expect(ir).toEqual<FallbackIR>({
      type: "fallback",
      reason: "refine",
    });
  });
});

describe("extractSchema — fallback (non-compilable schemas)", () => {
  it("returns fallback for transform with external capture", () => {
    const prefix = "hello";
    const ir = extractSchema(z.string().transform((v) => prefix + v));
    expect(ir).toEqual<FallbackIR>({
      type: "fallback",
      reason: "transform",
    });
  });
});

// ─── Complex / Real-World Schemas ───────────────────────────────────────────

describe("extractSchema — complex real-world schemas", () => {
  it("extracts a user schema", () => {
    const UserSchema = z.object({
      id: z.number().int().positive(),
      name: z.string().min(1).max(100),
      email: z.email(),
      role: z.enum(["admin", "user", "guest"]),
      active: z.boolean(),
      tags: z.array(z.string()).min(0).max(10),
      metadata: z.object({
        createdAt: z.string(),
        updatedAt: z.string().optional(),
      }),
    });

    const ir = extractSchema(UserSchema) as ObjectIR;
    expect(ir.type).toBe("object");
    expect(Object.keys(ir.properties)).toEqual([
      "id",
      "name",
      "email",
      "role",
      "active",
      "tags",
      "metadata",
    ]);

    // Verify nested types
    expect(ir.properties["id"]?.type).toBe("number");
    expect(ir.properties["name"]?.type).toBe("string");
    expect(ir.properties["email"]?.type).toBe("string");
    expect(ir.properties["role"]?.type).toBe("enum");
    expect(ir.properties["active"]?.type).toBe("boolean");
    expect(ir.properties["tags"]?.type).toBe("array");
    expect(ir.properties["metadata"]?.type).toBe("object");

    // Verify nested checks
    const idIR = ir.properties["id"] as NumberIR;
    expect(idIR.checks).toContainEqual({ kind: "number_format", format: "safeint" });
    expect(idIR.checks).toContainEqual({ kind: "greater_than", value: 0, inclusive: false });

    const nameIR = ir.properties["name"] as StringIR;
    expect(nameIR.checks).toContainEqual({ kind: "min_length", minimum: 1 });
    expect(nameIR.checks).toContainEqual({ kind: "max_length", maximum: 100 });

    const tagsIR = ir.properties["tags"] as ArrayIR;
    expect(tagsIR.element.type).toBe("string");
    expect(tagsIR.checks).toContainEqual({ kind: "min_length", minimum: 0 });
    expect(tagsIR.checks).toContainEqual({ kind: "max_length", maximum: 10 });

    // Verify nested object
    const metaIR = ir.properties["metadata"] as ObjectIR;
    expect(metaIR.properties["createdAt"]?.type).toBe("string");
    expect(metaIR.properties["updatedAt"]?.type).toBe("optional");
  });

  it("extracts an API request schema", () => {
    const RequestSchema = z.object({
      method: z.enum(["GET", "POST", "PUT", "DELETE"]),
      path: z.string().min(1),
      body: z
        .object({
          data: z.union([z.string(), z.number(), z.boolean()]),
        })
        .optional(),
      headers: z.array(
        z.object({
          key: z.string(),
          value: z.string(),
        }),
      ),
    });

    const ir = extractSchema(RequestSchema) as ObjectIR;
    expect(ir.type).toBe("object");

    const methodIR = ir.properties["method"] as EnumIR;
    expect(methodIR.values).toEqual(["GET", "POST", "PUT", "DELETE"]);

    const bodyIR = ir.properties["body"] as OptionalIR;
    expect(bodyIR.type).toBe("optional");
    expect(bodyIR.inner.type).toBe("object");

    const headersIR = ir.properties["headers"] as ArrayIR;
    expect(headersIR.element.type).toBe("object");
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe("extractSchema — edge cases", () => {
  it("handles deeply nested objects (5 levels)", () => {
    const schema = z.object({
      a: z.object({
        b: z.object({
          c: z.object({
            d: z.object({
              e: z.string(),
            }),
          }),
        }),
      }),
    });

    const ir = extractSchema(schema) as ObjectIR;
    const aIR = ir.properties["a"] as ObjectIR;
    const bIR = aIR.properties["b"] as ObjectIR;
    const cIR = bIR.properties["c"] as ObjectIR;
    const dIR = cIR.properties["d"] as ObjectIR;
    expect(dIR.properties["e"]?.type).toBe("string");
  });

  it("handles array of arrays of objects", () => {
    const schema = z.array(z.array(z.object({ x: z.number() })));
    const ir = extractSchema(schema) as ArrayIR;
    const innerArr = ir.element as ArrayIR;
    const objIR = innerArr.element as ObjectIR;
    expect(objIR.properties["x"]?.type).toBe("number");
  });

  it("handles union with many options", () => {
    const schema = z.union([z.literal("a"), z.literal("b"), z.literal("c"), z.literal("d")]);
    const ir = extractSchema(schema) as UnionIR;
    expect(ir.options).toHaveLength(4);
  });

  it("handles object with all property types", () => {
    const schema = z.object({
      str: z.string(),
      num: z.number(),
      bool: z.boolean(),
      nul: z.null(),
      undef: z.undefined(),
      opt: z.string().optional(),
      nullable: z.string().nullable(),
      arr: z.array(z.string()),
      en: z.enum(["a", "b"]),
      lit: z.literal("x"),
      union: z.union([z.string(), z.number()]),
      nested: z.object({ inner: z.string() }),
    });

    const ir = extractSchema(schema) as ObjectIR;
    expect(ir.properties["str"]?.type).toBe("string");
    expect(ir.properties["num"]?.type).toBe("number");
    expect(ir.properties["bool"]?.type).toBe("boolean");
    expect(ir.properties["nul"]?.type).toBe("null");
    expect(ir.properties["undef"]?.type).toBe("undefined");
    expect(ir.properties["opt"]?.type).toBe("optional");
    expect(ir.properties["nullable"]?.type).toBe("nullable");
    expect(ir.properties["arr"]?.type).toBe("array");
    expect(ir.properties["en"]?.type).toBe("enum");
    expect(ir.properties["lit"]?.type).toBe("literal");
    expect(ir.properties["union"]?.type).toBe("union");
    expect(ir.properties["nested"]?.type).toBe("object");
  });
});

// ─── Partial Fallback Collection ─────────────────────────────────────────────

describe("extractSchema — zero-capture transform produces EffectIR (no fallback)", () => {
  it("object with zero-capture transform property produces EffectIR, no fallback entries", () => {
    const schema = z.object({
      name: z.string(),
      slug: z.string().transform((v) => v.toLowerCase()),
    });
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as ObjectIR;

    expect(ir.type).toBe("object");
    expect(ir.properties["name"]?.type).toBe("string");
    expect(ir.properties["slug"]?.type).toBe("effect");
    const effectIR = ir.properties["slug"] as TransformEffectIR;
    expect(effectIR.effectKind).toBe("transform");
    expect(effectIR.source).toContain("toLowerCase");
    expect(effectIR.inner.type).toBe("string");
    expect(refs).toHaveLength(0);
  });

  it("zero-capture refine produces StringIR with refine_effect, no fallback entries", () => {
    const schema = z.object({
      a: z.string(),
      b: z.string().refine((v) => v.length > 0),
      c: z.number().refine((v) => v > 0),
    });
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as ObjectIR;

    expect(ir.properties["a"]?.type).toBe("string");
    expect(ir.properties["b"]?.type).toBe("string");
    expect(ir.properties["c"]?.type).toBe("number");
    expect(refs).toHaveLength(0);
  });

  it("array of zero-capture transform produces EffectIR element, no fallback entries", () => {
    const schema = z.array(z.string().transform((v) => parseInt(v, 10)));
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as ArrayIR;

    expect(ir.type).toBe("array");
    expect(ir.element.type).toBe("effect");
    expect(refs).toHaveLength(0);
  });

  it("optional zero-capture transform produces EffectIR inner, no fallback entries", () => {
    const schema = z.optional(z.string().transform((v) => v.toUpperCase()));
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs);

    expect(ir.type).toBe("optional");
    expect((ir as OptionalIR).inner.type).toBe("effect");
    expect(refs).toHaveLength(0);
  });

  it("zero-capture transform without refs array produces EffectIR", () => {
    const schema = z.object({
      name: z.string(),
      slug: z.string().transform((v) => v.toLowerCase()),
    });
    const ir = extractSchema(schema) as ObjectIR;

    expect(ir.properties["slug"]?.type).toBe("effect");
  });

  it("nullable zero-capture transform produces EffectIR inner, no fallback entries", () => {
    const schema = z.nullable(z.string().transform((v) => v.toUpperCase()));
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as NullableIR;

    expect(ir.type).toBe("nullable");
    expect(ir.inner.type).toBe("effect");
    expect(refs).toHaveLength(0);
  });

  it("tuple with zero-capture transform item produces EffectIR, no fallback entries", () => {
    const schema = z.tuple([z.string(), z.number().transform((v) => String(v))]);
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as TupleIR;

    expect(ir.type).toBe("tuple");
    expect(ir.items).toHaveLength(2);
    expect(ir.items[0]?.type).toBe("string");
    expect(ir.items[1]?.type).toBe("effect");
    expect(refs).toHaveLength(0);
  });

  it("tuple rest with zero-capture transform produces EffectIR, no fallback entries", () => {
    const schema = z.tuple([z.string()]).rest(z.number().transform((v) => String(v)));
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as TupleIR;

    expect(ir.type).toBe("tuple");
    expect(ir.items[0]?.type).toBe("string");
    expect(ir.rest).not.toBeNull();
    expect(ir.rest?.type).toBe("effect");
    expect(refs).toHaveLength(0);
  });

  it("record with zero-capture transform value produces EffectIR, no fallback entries", () => {
    const schema = z.record(
      z.string(),
      z.string().transform((v) => v.trim()),
    );
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as RecordIR;

    expect(ir.type).toBe("record");
    expect(ir.keyType.type).toBe("string");
    expect(ir.valueType.type).toBe("effect");
    expect(refs).toHaveLength(0);
  });

  it("union with zero-capture transform option produces EffectIR, no fallback entries", () => {
    const schema = z.union([z.string(), z.number().transform((v) => String(v))]);
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as UnionIR;

    expect(ir.type).toBe("union");
    expect(ir.options).toHaveLength(2);
    expect(ir.options[0]?.type).toBe("string");
    expect(ir.options[1]?.type).toBe("effect");
    expect(refs).toHaveLength(0);
  });

  it("discriminatedUnion with zero-capture transform produces EffectIR, no fallback entries", () => {
    const schema = z.discriminatedUnion("type", [
      z.object({ type: z.literal("a"), value: z.string() }),
      z.object({ type: z.literal("b"), value: z.string().transform((v) => v.trim()) }),
    ]);
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as DiscriminatedUnionIR;

    expect(ir.type).toBe("discriminatedUnion");
    expect(ir.options).toHaveLength(2);
    const opt0 = ir.options[0] as ObjectIR;
    expect(opt0.properties["value"]?.type).toBe("string");
    const opt1 = ir.options[1] as ObjectIR;
    expect(opt1.properties["value"]?.type).toBe("effect");
    expect(refs).toHaveLength(0);
  });

  it("intersection with a transform side falls back (Zod merges/conflicts)", () => {
    const schema = z.intersection(
      z.object({ a: z.string() }),
      z.object({ b: z.string().transform((v) => v.toLowerCase()) }),
    );
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs);
    // Mutating sides change the value mid-validation; Zod validates both
    // sides on the original input and merges — delegate to Zod.
    expect(ir.type).toBe("fallback");
    expect(refs).toHaveLength(1);
  });

  it("readonly object falls back as a whole (Zod freezes its output)", () => {
    const schema = z
      .object({
        name: z.string(),
        slug: z.string().transform((v) => v.toLowerCase()),
      })
      .readonly();
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs);

    expect(ir.type).toBe("fallback");
    expect(refs).toHaveLength(1);
  });

  it("default object with zero-capture transform produces EffectIR, default uses runtime ref", () => {
    const schema = z
      .object({
        name: z.string(),
        slug: z.string().transform((v) => v.toLowerCase()),
      })
      .default({ name: "test", slug: "test" });
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as DefaultIR;

    expect(ir.type).toBe("default");
    expect(ir.inner.type).toBe("object");
    const objIR = ir.inner as ObjectIR;
    expect(objIR.properties["slug"]?.type).toBe("effect");
    // default always stores a runtime reference for the default value
    expect(refs).toHaveLength(1);
    expect(ir.refIndex).toBe(0);
  });

  it("deep nested zero-capture transform produces EffectIR, no fallback entries", () => {
    const schema = z.object({
      items: z.array(
        z.object({
          name: z.string(),
          value: z.string().transform((v) => Number.parseInt(v, 10)),
        }),
      ),
    });
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as ObjectIR;

    expect(ir.type).toBe("object");
    const itemsIR = ir.properties["items"] as ArrayIR;
    expect(itemsIR.type).toBe("array");
    const elemIR = itemsIR.element as ObjectIR;
    expect(elemIR.type).toBe("object");
    expect(elemIR.properties["name"]?.type).toBe("string");
    expect(elemIR.properties["value"]?.type).toBe("effect");
    expect(refs).toHaveLength(0);
  });

  it("zero-capture transform produces no fallback entries (no schema reference stored)", () => {
    const slugSchema = z.string().transform((v) => v.toLowerCase());
    const schema = z.object({ slug: slugSchema });
    const refs: RefEntry[] = [];
    extractSchema(schema, refs);

    expect(refs).toHaveLength(0);
  });
});

describe("extractSchema — partial fallback (RefEntry collection with external captures)", () => {
  it("collects fallback entries for object with captured-variable transform property", () => {
    const prefix = "prefix_";
    const schema = z.object({
      name: z.string(),
      slug: z.string().transform((v) => prefix + v),
    });
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as ObjectIR;

    expect(ir.type).toBe("object");
    expect(ir.properties["name"]?.type).toBe("string");
    expect(ir.properties["slug"]?.type).toBe("fallback");
    expect((ir.properties["slug"] as FallbackIR).refIndex).toBe(0);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.accessPath).toBe('.shape["slug"]');
  });

  it("stores the original Zod schema reference in fallback entries for captured transform", () => {
    const external = "captured";
    const slugSchema = z.string().transform((v) => external + v);
    const schema = z.object({ slug: slugSchema });
    const refs: RefEntry[] = [];
    extractSchema(schema, refs);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.schema).toBeDefined();
  });
});
