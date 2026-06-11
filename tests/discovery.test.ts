import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { discoverSchemas } from "#src/discovery.js";

const fixturesDir = path.resolve(import.meta.dirname, "fixtures");

describe("discoverSchemas()", () => {
  it("discovers schemas nested under default export (ESM/CJS interop)", async () => {
    const { compile } = await import("#src/core/compile.js");
    const { z } = await import("zod");

    const schema = z.object({ name: z.string() });
    const compiled = compile(schema);

    // Mock loadSourceFile to return a module with exports nested under default
    vi.spyOn(await import("#src/loader.js"), "loadSourceFile").mockResolvedValueOnce({
      default: { validateUser: compiled },
    });

    const schemas = await discoverSchemas("fake-path.ts");
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.exportName).toBe("validateUser");

    vi.restoreAllMocks();
  });

  it("discovers schemas from both top-level and default exports", async () => {
    const { compile } = await import("#src/core/compile.js");
    const { z } = await import("zod");

    const schema1 = z.object({ name: z.string() });
    const schema2 = z.object({ age: z.number() });
    const compiled1 = compile(schema1);
    const compiled2 = compile(schema2);

    vi.spyOn(await import("#src/loader.js"), "loadSourceFile").mockResolvedValueOnce({
      validateName: compiled1,
      default: { validateAge: compiled2 },
    });

    const schemas = await discoverSchemas("fake-path.ts");
    expect(schemas).toHaveLength(2);
    const names = schemas.map((s) => s.exportName).sort();
    expect(names).toEqual(["validateAge", "validateName"]);

    vi.restoreAllMocks();
  });

  it("does not unwrap default export that is itself a CompiledSchema", async () => {
    const { compile } = await import("#src/core/compile.js");
    const { z } = await import("zod");

    const schema = z.object({ name: z.string() });
    const compiled = compile(schema);

    vi.spyOn(await import("#src/loader.js"), "loadSourceFile").mockResolvedValueOnce({
      default: compiled,
    });

    const schemas = await discoverSchemas("fake-path.ts");
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.exportName).toBe("default");

    vi.restoreAllMocks();
  });

  it("discovers compile() calls in a simple schema file", async () => {
    const schemas = await discoverSchemas(path.join(fixturesDir, "simple-schema.ts"));

    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.exportName).toBe("validateUser");
    expect(schemas[0]?.schema).toBeDefined();
  });

  it("discovers multiple compile() calls in a single file", async () => {
    const schemas = await discoverSchemas(path.join(fixturesDir, "multi-schema.ts"));

    expect(schemas).toHaveLength(2);
    const names = schemas.map((s) => s.exportName).sort();
    expect(names).toEqual(["validateProduct", "validateUser"]);
  });

  it("returns empty array when no compile() calls exist", async () => {
    const schemas = await discoverSchemas(path.join(fixturesDir, "no-compile.ts"));

    expect(schemas).toHaveLength(0);
  });

  it("discovers schemas with fallback types (transform)", async () => {
    const schemas = await discoverSchemas(path.join(fixturesDir, "with-fallback.ts"));

    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.exportName).toBe("validateTransform");
  });

  describe("autoDiscover mode", () => {
    it("discovers plain Zod exports when autoDiscover is true", async () => {
      const schemas = await discoverSchemas(path.join(fixturesDir, "auto-discover-simple.ts"), {
        autoDiscover: true,
      });

      expect(schemas).toHaveLength(1);
      expect(schemas[0]?.exportName).toBe("UserSchema");
      expect(schemas[0]?.schema).toBeDefined();
    });

    it("discovers multiple plain Zod exports", async () => {
      const schemas = await discoverSchemas(path.join(fixturesDir, "auto-discover-multi.ts"), {
        autoDiscover: true,
      });

      expect(schemas).toHaveLength(2);
      const names = schemas.map((s) => s.exportName).sort();
      expect(names).toEqual(["ProductSchema", "UserSchema"]);
    });

    it("ignores plain Zod exports when autoDiscover is false", async () => {
      const schemas = await discoverSchemas(path.join(fixturesDir, "auto-discover-simple.ts"));

      expect(schemas).toHaveLength(0);
    });

    it("prioritizes compile() schemas over autoDiscover", async () => {
      const schemas = await discoverSchemas(path.join(fixturesDir, "auto-discover-mixed.ts"), {
        autoDiscover: true,
      });

      expect(schemas).toHaveLength(2);
      const compileSchema = schemas.find((s) => s.exportName === "validateUser");
      const autoSchema = schemas.find((s) => s.exportName === "ProductSchema");
      expect(compileSchema).toBeDefined();
      expect(autoSchema).toBeDefined();
    });

    it("returns empty array for file with no Zod exports", async () => {
      vi.spyOn(await import("#src/loader.js"), "loadSourceFile").mockResolvedValueOnce({
        greeting: "hello",
        count: 42,
      });

      const schemas = await discoverSchemas("fake-path.ts", { autoDiscover: true });
      expect(schemas).toHaveLength(0);

      vi.restoreAllMocks();
    });

    it("does not match non-object values as Zod schemas", async () => {
      vi.spyOn(await import("#src/loader.js"), "loadSourceFile").mockResolvedValueOnce({
        str: "not a schema",
        num: 42,
        nul: null,
        undef: undefined,
      });

      const schemas = await discoverSchemas("fake-path.ts", { autoDiscover: true });
      expect(schemas).toHaveLength(0);

      vi.restoreAllMocks();
    });

    it("does not match plain objects without _zod as Zod schemas", async () => {
      vi.spyOn(await import("#src/loader.js"), "loadSourceFile").mockResolvedValueOnce({
        notASchema: { name: "test", age: 42 },
      });

      const schemas = await discoverSchemas("fake-path.ts", { autoDiscover: true });
      expect(schemas).toHaveLength(0);

      vi.restoreAllMocks();
    });
  });
});
