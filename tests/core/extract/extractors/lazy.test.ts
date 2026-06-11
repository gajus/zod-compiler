import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import type {
  ArrayIR,
  FallbackIR,
  NullableIR,
  ObjectIR,
  OptionalIR,
  RecordIR,
  StringIR,
  UnionIR,
} from "#src/core/types.js";

// ─── Non-recursive lazy ─────────────────────────────────────────────────────

describe("extractSchema — lazy (non-recursive)", () => {
  it("resolves z.lazy(() => z.string()) to StringIR", () => {
    const ir = extractSchema(z.lazy(() => z.string()));
    expect(ir).toEqual<StringIR>({ type: "string", checks: [] });
  });

  it("resolves z.lazy(() => z.number()) to NumberIR", () => {
    const ir = extractSchema(z.lazy(() => z.number()));
    expect(ir.type).toBe("number");
  });

  it("resolves lazy wrapping an object schema", () => {
    const ir = extractSchema(z.lazy(() => z.object({ name: z.string() }))) as ObjectIR;
    expect(ir.type).toBe("object");
    expect(ir.properties["name"]?.type).toBe("string");
  });

  it("resolves nested lazy (lazy inside lazy)", () => {
    const ir = extractSchema(z.lazy(() => z.lazy(() => z.boolean())));
    expect(ir.type).toBe("boolean");
  });

  it("resolves lazy inside optional", () => {
    const ir = extractSchema(z.optional(z.lazy(() => z.string()))) as OptionalIR;
    expect(ir.type).toBe("optional");
    expect(ir.inner.type).toBe("string");
  });

  it("resolves lazy inside array", () => {
    const ir = extractSchema(z.array(z.lazy(() => z.number()))) as ArrayIR;
    expect(ir.type).toBe("array");
    expect(ir.element.type).toBe("number");
  });

  it("does not produce fallback entries for non-recursive lazy", () => {
    const refs: RefEntry[] = [];
    const ir = extractSchema(
      z.lazy(() => z.string()),
      refs,
    );
    expect(ir.type).toBe("string");
    expect(refs).toHaveLength(0);
  });
});

// ─── Recursive lazy (cycle detection) ───────────────────────────────────────

describe("extractSchema — lazy (recursive / cycle detection)", () => {
  it("detects cycle in self-referencing tree node and emits recursiveRef", () => {
    const TreeNode: z.ZodType = z.object({
      value: z.string(),
      children: z.array(z.lazy(() => TreeNode)),
    });
    const ir = extractSchema(TreeNode) as ObjectIR;
    expect(ir.type).toBe("object");
    expect(ir.properties["value"]?.type).toBe("string");

    // children is an array whose element hits the cycle → recursiveRef
    const childrenIR = ir.properties["children"] as ArrayIR;
    expect(childrenIR.type).toBe("array");
    expect(childrenIR.element.type).toBe("recursiveRef");
  });

  it("does not collect fallback entry for recursive reference point", () => {
    const TreeNode: z.ZodType = z.object({
      value: z.string(),
      children: z.array(z.lazy(() => TreeNode)),
    });
    const refs: RefEntry[] = [];
    extractSchema(TreeNode, refs);
    expect(refs).toHaveLength(0);
  });

  it("handles mutual recursion (A → lazy(B), B → lazy(A))", () => {
    const A: z.ZodType = z.object({
      b: z.lazy(() => B),
    });
    const B: z.ZodType = z.object({
      a: z.lazy(() => A),
    });
    const ir = extractSchema(A) as ObjectIR;
    expect(ir.type).toBe("object");

    // A.b resolves to B (object), but B.a hits cycle back to A → recursiveRef
    const bIR = ir.properties["b"] as ObjectIR;
    expect(bIR.type).toBe("object");
    expect(bIR.properties["a"]?.type).toBe("recursiveRef");
  });

  it("does not falsely detect cycle for DAG (same schema referenced from siblings)", () => {
    const Shared = z.object({ x: z.number() });
    const Parent = z.object({
      left: z.lazy(() => Shared),
      right: z.lazy(() => Shared),
    });
    const ir = extractSchema(Parent) as ObjectIR;
    // Both should resolve fully — no cycle
    expect((ir.properties["left"] as ObjectIR).type).toBe("object");
    expect((ir.properties["right"] as ObjectIR).type).toBe("object");
    expect((ir.properties["left"] as ObjectIR).properties["x"]?.type).toBe("number");
    expect((ir.properties["right"] as ObjectIR).properties["x"]?.type).toBe("number");
  });

  it("compiles non-recursive parts of a recursive schema", () => {
    const JsonValue: z.ZodType = z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.lazy(() => JsonValue)),
      z.record(
        z.string(),
        z.lazy(() => JsonValue),
      ),
    ]);
    const refs: RefEntry[] = [];
    const ir = extractSchema(JsonValue, refs);
    expect(ir.type).toBe("union");
    // Recursive references become recursiveRef IR, no fallbacks needed
    expect(refs).toHaveLength(0);
  });

  it("emits recursiveRef inside nullable (linked list pattern)", () => {
    const ListNode: z.ZodType = z.object({
      value: z.number(),
      next: z.lazy(() => ListNode).nullable(),
    });
    const ir = extractSchema(ListNode) as ObjectIR;
    expect(ir.type).toBe("object");
    expect(ir.properties["value"]?.type).toBe("number");

    const nextIR = ir.properties["next"] as NullableIR;
    expect(nextIR.type).toBe("nullable");
    expect(nextIR.inner.type).toBe("recursiveRef");
  });

  it("emits recursiveRef inside optional", () => {
    const OptNode: z.ZodType = z.object({
      value: z.string(),
      child: z.lazy(() => OptNode).optional(),
    });
    const ir = extractSchema(OptNode) as ObjectIR;
    expect(ir.type).toBe("object");

    const childIR = ir.properties["child"] as OptionalIR;
    expect(childIR.type).toBe("optional");
    expect(childIR.inner.type).toBe("recursiveRef");
  });

  it("emits recursiveRef inside record value", () => {
    const DirNode: z.ZodType = z.object({
      name: z.string(),
      subdirs: z.record(
        z.string(),
        z.lazy(() => DirNode),
      ),
    });
    const ir = extractSchema(DirNode) as ObjectIR;
    expect(ir.type).toBe("object");

    const subdirsIR = ir.properties["subdirs"] as RecordIR;
    expect(subdirsIR.type).toBe("record");
    expect(subdirsIR.valueType.type).toBe("recursiveRef");
  });

  it("emits recursiveRef inside union options (JSON value)", () => {
    const JsonVal: z.ZodType = z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.lazy(() => JsonVal)),
      z.record(
        z.string(),
        z.lazy(() => JsonVal),
      ),
    ]);
    const ir = extractSchema(JsonVal) as UnionIR;
    expect(ir.type).toBe("union");
    expect(ir.options).toHaveLength(6);

    // array element should be recursiveRef
    const arrayOption = ir.options[4] as ArrayIR;
    expect(arrayOption.type).toBe("array");
    expect(arrayOption.element.type).toBe("recursiveRef");

    // record value should be recursiveRef
    const recordOption = ir.options[5] as RecordIR;
    expect(recordOption.type).toBe("record");
    expect(recordOption.valueType.type).toBe("recursiveRef");
  });

  it("emits recursiveRef for multiple self-references in one schema", () => {
    const BinaryTree: z.ZodType = z.object({
      value: z.number(),
      left: z.lazy(() => BinaryTree).nullable(),
      right: z.lazy(() => BinaryTree).nullable(),
    });
    const ir = extractSchema(BinaryTree) as ObjectIR;
    expect(ir.type).toBe("object");

    const leftIR = ir.properties["left"] as NullableIR;
    const rightIR = ir.properties["right"] as NullableIR;
    expect(leftIR.inner.type).toBe("recursiveRef");
    expect(rightIR.inner.type).toBe("recursiveRef");
  });

  it("falls back when innerType is falsy", () => {
    const schema = z.lazy(() => z.string());
    // Simulate missing innerType
    (schema._zod as unknown as Record<string, unknown>).innerType = undefined;
    const ir = extractSchema(schema);
    expect(ir.type).toBe("fallback");
    expect((ir as FallbackIR).reason).toBe("lazy");
  });
});
