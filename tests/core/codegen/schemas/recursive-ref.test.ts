import { describe, expect, it } from "vitest";
import type { CodeGenContext } from "#src/core/codegen/context.js";
import { slowRecursiveRef } from "#src/core/codegen/schemas/recursive-ref.js";
import { createSlowGen } from "#src/core/codegen/slow-path.js";
import type { ObjectIR, RecursiveRefIR } from "#src/core/types.js";
import { compileIR } from "../helpers.js";

describe("slow-path — recursiveRef", () => {
  it("generates self-call with correct function name", () => {
    const ctx: CodeGenContext = {
      preamble: [],
      counter: 0,
      fnName: "safeParse_tree",
      regexCache: new Map(),
      mode: "inline",
      usedHelpers: new Set(),
    };
    const ir: RecursiveRefIR = { type: "recursiveRef" };
    const g = createSlowGen("input", "input", "[]", "__issues", ctx);
    const code = slowRecursiveRef(ir, g);
    expect(code).toContain("safeParse_tree(input)");
    expect(code).toContain("__rec_r0");
  });

  it("increments counter for unique variable names", () => {
    const ctx: CodeGenContext = {
      preamble: [],
      counter: 5,
      fnName: "safeParse_node",
      regexCache: new Map(),
      mode: "inline",
      usedHelpers: new Set(),
    };
    const ir: RecursiveRefIR = { type: "recursiveRef" };
    const g = createSlowGen("v", "v", "p", "iss", ctx);
    const code = slowRecursiveRef(ir, g);
    expect(code).toContain("__rec_r5");
    expect(code).toContain("__rec_i5");
    expect(code).toContain("__rec_j5");
    expect(ctx.counter).toBe(6);
  });

  it("merges error issues with path on failure", () => {
    const ctx: CodeGenContext = {
      preamble: [],
      counter: 0,
      fnName: "safeParse_test",
      regexCache: new Map(),
      mode: "inline",
      usedHelpers: new Set(),
    };
    const ir: RecursiveRefIR = { type: "recursiveRef" };
    const g = createSlowGen("input", "input", '["children",0]', "__issues", ctx);
    const code = slowRecursiveRef(ir, g);
    expect(code).toContain(".concat(");
    expect(code).toContain(".path)");
  });

  it("writes back data on success", () => {
    const ctx: CodeGenContext = {
      preamble: [],
      counter: 0,
      fnName: "safeParse_test",
      regexCache: new Map(),
      mode: "inline",
      usedHelpers: new Set(),
    };
    const ir: RecursiveRefIR = { type: "recursiveRef" };
    const g = createSlowGen("input", "input", "[]", "__issues", ctx);
    const code = slowRecursiveRef(ir, g);
    expect(code).toContain("input=__rec_r0.data");
  });

  it("validates tree node recursively at runtime", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        value: { type: "string", checks: [] },
        children: {
          type: "array",
          element: { type: "recursiveRef" },
          checks: [],
        },
      },
    };
    const safeParse = compileIR(ir, "test");

    // Valid: leaf node
    expect(safeParse({ value: "leaf", children: [] }).success).toBe(true);

    // Valid: one level deep
    expect(safeParse({ value: "root", children: [{ value: "child", children: [] }] }).success).toBe(
      true,
    );

    // Valid: two levels deep
    expect(
      safeParse({
        value: "root",
        children: [{ value: "child", children: [{ value: "grandchild", children: [] }] }],
      }).success,
    ).toBe(true);

    // Invalid: bad value type at root
    expect(safeParse({ value: 42, children: [] }).success).toBe(false);

    // Invalid: bad value type in nested child
    expect(safeParse({ value: "root", children: [{ value: 123, children: [] }] }).success).toBe(
      false,
    );

    // Invalid: children not an array
    expect(safeParse({ value: "root", children: "not array" }).success).toBe(false);

    // Invalid: not an object
    expect(safeParse("not an object").success).toBe(false);
  });

  it("provides correct nested error paths", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        value: { type: "string", checks: [] },
        children: {
          type: "array",
          element: { type: "recursiveRef" },
          checks: [],
        },
      },
    };
    const safeParse = compileIR(ir, "test");

    // Error deep in tree should have full path
    const result = safeParse({
      value: "root",
      children: [
        {
          value: "child",
          children: [{ value: 42, children: [] }],
        },
      ],
    });
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0] as { path: (string | number)[] };
    expect(issue.path).toEqual(["children", 0, "children", 0, "value"]);
  });

  it("validates linked list (nullable recursive ref)", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        value: { type: "number", checks: [] },
        next: {
          type: "nullable",
          inner: { type: "recursiveRef" },
        },
      },
    };
    const safeParse = compileIR(ir, "test");

    // Valid: end of list
    expect(safeParse({ value: 1, next: null }).success).toBe(true);

    // Valid: linked list
    expect(
      safeParse({ value: 1, next: { value: 2, next: { value: 3, next: null } } }).success,
    ).toBe(true);

    // Invalid: bad value in nested node
    expect(safeParse({ value: 1, next: { value: "bad", next: null } }).success).toBe(false);
  });

  it("validates recursive union (JSON-like value)", () => {
    const recursiveRef: RecursiveRefIR = { type: "recursiveRef" };
    const ir = {
      type: "union" as const,
      options: [
        { type: "string" as const, checks: [] },
        { type: "number" as const, checks: [] },
        { type: "boolean" as const },
        { type: "null" as const },
        { type: "array" as const, element: recursiveRef, checks: [] },
      ],
    };
    const safeParse = compileIR(ir, "test");

    expect(safeParse("hello").success).toBe(true);
    expect(safeParse(42).success).toBe(true);
    expect(safeParse(true).success).toBe(true);
    expect(safeParse(null).success).toBe(true);
    expect(safeParse(["hello", 42, [true, null]]).success).toBe(true);
    expect(safeParse({}).success).toBe(false);
  });
});
