import { describe, expect, it } from "vitest";
import type { ArrayIR, ObjectIR, RecordIR, TupleIR } from "#src/core/types.js";
import { compileIR } from "../helpers.js";

describe("slow-path — no input mutation", () => {
  describe("object with coerce", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        port: { type: "number", checks: [], coerce: true },
        host: { type: "string", checks: [] },
      },
    };

    it("does not mutate the original input object", () => {
      const input = { port: "3000", host: "localhost" };
      const safeParse = compileIR(ir);
      const result = safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ port: 3000, host: "localhost" });
      // Original must remain untouched
      expect(input.port).toBe("3000");
      expect(typeof input.port).toBe("string");
    });

    it("works with process.env-like objects with string-coercing setters", () => {
      // Simulate process.env: all property assignments are coerced to strings
      const backing: Record<string, string> = {};
      const envLike: Record<string, string> = {};
      for (const key of ["port", "host"]) {
        Object.defineProperty(envLike, key, {
          get() {
            return backing[key];
          },
          set(v: unknown) {
            backing[key] = String(v);
          },
          enumerable: true,
          configurable: true,
        });
      }
      envLike["port"] = "8080";
      envLike["host"] = "localhost";

      const safeParse = compileIR(ir);
      const result = safeParse(envLike);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ port: 8080, host: "localhost" });
      // Original env-like object must keep string values
      expect(envLike["port"]).toBe("8080");
    });
  });

  describe("object with default", () => {
    it("does not mutate the original input object", () => {
      const ir: ObjectIR = {
        type: "object",
        properties: {
          name: {
            type: "default",
            inner: { type: "string", checks: [] },
            refIndex: 0,
          },
        },
      };
      const input: Record<string, unknown> = {};
      const safeParse = compileIR(ir, "test", [{ _zod: { def: { defaultValue: "anonymous" } } }]);
      const result = safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: "anonymous" });
      // Original must not have the default value inserted
      expect(input["name"]).toBeUndefined();
    });
  });

  describe("object with catch", () => {
    it("does not mutate the original input object", () => {
      const ir: ObjectIR = {
        type: "object",
        properties: {
          value: {
            type: "catch",
            inner: { type: "number", checks: [] },
            refIndex: 0,
          },
        },
      };
      const input = { value: "not a number" };
      const safeParse = compileIR(ir, "test", [{ _zod: { def: { catchValue: () => 0 } } }]);
      const result = safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ value: 0 });
      // Original must keep its original value
      expect(input.value).toBe("not a number");
    });
  });

  describe("nested object with coerce", () => {
    it("does not mutate nested input objects", () => {
      const ir: ObjectIR = {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              port: { type: "number", checks: [], coerce: true },
            },
          },
        },
      };
      const innerConfig = { port: "3000" };
      const input = { config: innerConfig };
      const safeParse = compileIR(ir);
      const result = safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ config: { port: 3000 } });
      // Both outer and inner must remain untouched
      expect(input.config).toBe(innerConfig);
      expect(innerConfig.port).toBe("3000");
    });
  });

  describe("array with coerce element", () => {
    it("does not mutate the original array", () => {
      const ir: ArrayIR = {
        type: "array",
        element: { type: "number", checks: [], coerce: true },
        checks: [],
      };
      const input = ["1", "2", "3"];
      const safeParse = compileIR(ir);
      const result = safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual([1, 2, 3]);
      // Original array must remain strings
      expect(input).toEqual(["1", "2", "3"]);
    });
  });

  describe("tuple with coerce item", () => {
    it("does not mutate the original tuple array", () => {
      const ir: TupleIR = {
        type: "tuple",
        items: [
          { type: "number", checks: [], coerce: true },
          { type: "string", checks: [] },
        ],
        rest: null,
      };
      const input = ["42", "hello"];
      const safeParse = compileIR(ir);
      const result = safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual([42, "hello"]);
      // Original must remain a string
      expect(input[0]).toBe("42");
    });
  });

  describe("record with coerce value", () => {
    it("does not mutate the original record", () => {
      const ir: RecordIR = {
        type: "record",
        keyType: { type: "string", checks: [] },
        valueType: { type: "number", checks: [], coerce: true },
      };
      const input = { a: "1", b: "2" };
      const safeParse = compileIR(ir);
      const result = safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ a: 1, b: 2 });
      // Original must remain strings
      expect(input).toEqual({ a: "1", b: "2" });
    });
  });

  describe("no unnecessary cloning", () => {
    it("returns the same reference when no mutations are needed", () => {
      const ir: ObjectIR = {
        type: "object",
        properties: {
          name: { type: "string", checks: [] },
          age: { type: "number", checks: [] },
        },
      };
      const input = { name: "Alice", age: 30 };
      const safeParse = compileIR(ir);
      const result = safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data).toBe(input); // same reference, no clone
    });
  });
});
