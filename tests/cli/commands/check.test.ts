import path from "node:path";
import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { diagnoseSchema } from "#src/core/diagnostic.js";
import { extractSchema } from "#src/core/extract/index.js";
import { discoverSchemas } from "#src/discovery.js";

// Mock discoverSchemas: delegates to real implementation by default,
// can be overridden per-test with mockResolvedValueOnce.
vi.mock("#src/discovery.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/discovery.js")>();
  return {
    ...original,
    discoverSchemas: vi.fn().mockImplementation(original.discoverSchemas),
  };
});

const mockDiscoverSchemas = vi.mocked(discoverSchemas);
const fixturesDir = path.resolve(import.meta.dirname, "../../fixtures");

const defaultOpts = {
  json: false,
  failUnder: undefined,
  noColor: true,
  autoDiscover: false,
};

describe("check (schema compilability)", () => {
  it("simple schema is fully compilable", async () => {
    const schemas = await discoverSchemas(path.join(fixturesDir, "simple-schema.ts"));

    for (const s of schemas) {
      const ir = extractSchema(s.schema);
      expect(diagnoseSchema(ir).fallbacks).toHaveLength(0);
    }
  });

  it("multi schema is fully compilable", async () => {
    const schemas = await discoverSchemas(path.join(fixturesDir, "multi-schema.ts"));
    expect(schemas.length).toBe(2);

    for (const s of schemas) {
      const ir = extractSchema(s.schema);
      expect(diagnoseSchema(ir).fallbacks).toHaveLength(0);
    }
  });

  it("captured-variable transform schema has fallback", async () => {
    const schemas = await discoverSchemas(path.join(fixturesDir, "with-fallback.ts"));
    expect(schemas.length).toBe(1);

    for (const s of schemas) {
      const ir = extractSchema(s.schema);
      const { fallbacks } = diagnoseSchema(ir);
      expect(fallbacks.length).toBeGreaterThan(0);
      expect(fallbacks.some((f) => f.reason.includes("transform"))).toBe(true);
    }
  });

  it("no-compile file has no schemas", async () => {
    const schemas = await discoverSchemas(path.join(fixturesDir, "no-compile.ts"));
    expect(schemas.length).toBe(0);
  });
});

describe("runCheck", () => {
  it("exits with error for non-existent file", async () => {
    const { runCheck } = await import("#src/cli/commands/check.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(runCheck({ inputs: ["/nonexistent/file.ts"], ...defaultOpts })).rejects.toThrow(
        "process.exit",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("exits with error for directory input", async () => {
    const { runCheck } = await import("#src/cli/commands/check.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(runCheck({ inputs: [fixturesDir], ...defaultOpts })).rejects.toThrow(
        "process.exit",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("outputs tree for compilable schema", async () => {
    const { runCheck } = await import("#src/cli/commands/check.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await runCheck({
        inputs: [path.join(fixturesDir, "simple-schema.ts")],
        ...defaultOpts,
      });
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("100%");
      expect(output).toContain("compiled");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("shows fallback hints in output without exiting", async () => {
    const { runCheck } = await import("#src/cli/commands/check.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await runCheck({
        inputs: [path.join(fixturesDir, "with-fallback.ts")],
        ...defaultOpts,
      });
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("transform");
      expect(output).toContain("Fallbacks:");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("shows Fast Path eligibility in output", async () => {
    const { runCheck } = await import("#src/cli/commands/check.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await runCheck({
        inputs: [path.join(fixturesDir, "simple-schema.ts")],
        ...defaultOpts,
      });
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Fast Path:");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("warns and exits with 1 when no compile() calls found", async () => {
    const { runCheck } = await import("#src/cli/commands/check.js");
    const logSpy = vi.spyOn(await import("#src/cli/logger.js"), "logger", "get");
    const mockLogger = {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      dim: vi.fn(),
    };
    logSpy.mockReturnValue(mockLogger);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        runCheck({
          inputs: [path.join(fixturesDir, "no-compile.ts")],
          ...defaultOpts,
        }),
      ).rejects.toThrow("process.exit");
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("no compile() calls"));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("--auto-discover"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("finds plain Zod exports with --auto-discover", async () => {
    const { runCheck } = await import("#src/cli/commands/check.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await runCheck({
        inputs: [path.join(fixturesDir, "auto-discover-simple.ts")],
        ...defaultOpts,
        autoDiscover: true,
      });
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("UserSchema");
      expect(output).toContain("100%");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

// ─── --json flag ─────────────────────────────────────────────────────────────

describe("runCheck --json", () => {
  it("outputs valid JSON report", async () => {
    const { runCheck } = await import("#src/cli/commands/check.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await runCheck({
        inputs: [path.join(fixturesDir, "simple-schema.ts")],
        json: true,
        failUnder: undefined,
        noColor: true,
        autoDiscover: false,
      });
      const jsonOutput = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1]?.[0] as string;
      const report = JSON.parse(jsonOutput);
      expect(Array.isArray(report)).toBe(true);
      expect(report[0].schemas).toBeDefined();
      expect(report[0].schemas[0].coverage.percent).toBe(100);
      expect(report[0].schemas[0].fastPath.eligible).toBe(true);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("JSON report includes fastPath blocker when ineligible", async () => {
    mockDiscoverSchemas.mockResolvedValueOnce([
      { exportName: "testSchema", schema: z.object({ value: z.string().transform((v) => v) }) },
    ]);

    const { runCheck } = await import("#src/cli/commands/check.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await runCheck({
        inputs: [path.join(fixturesDir, "simple-schema.ts")],
        json: true,
        failUnder: undefined,
        noColor: true,
        autoDiscover: false,
      });
      const jsonOutput = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1]?.[0] as string;
      const report = JSON.parse(jsonOutput);
      expect(report[0].schemas[0].fastPath.eligible).toBe(false);
      expect(report[0].schemas[0].fastPath.blocker).toBeDefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

// ─── --fail-under flag ──────────────────────────────────────────────────────

describe("runCheck --fail-under", () => {
  const realModule = vi.importActual<typeof import("#src/discovery.js")>("#src/discovery.js");
  const existingFilePath = path.join(fixturesDir, "simple-schema.ts");

  beforeEach(async () => {
    const { discoverSchemas: real } = await realModule;
    mockDiscoverSchemas.mockImplementation(real);
  });

  it("exits with 1 when coverage is below threshold", async () => {
    // Use superRefine (non-compilable) to ensure fallback and coverage < 100%
    mockDiscoverSchemas.mockResolvedValueOnce([
      {
        exportName: "testSchema",
        schema: z.object({
          name: z.string(),
          slug: z.string().superRefine((val, ctx) => {
            if (val.length < 1) ctx.addIssue({ code: "custom", message: "too short" });
          }),
        }),
      },
    ]);

    const { runCheck } = await import("#src/cli/commands/check.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        runCheck({ inputs: [existingFilePath], json: false, failUnder: 100, noColor: true }),
      ).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("does not exit when coverage meets threshold", async () => {
    const { runCheck } = await import("#src/cli/commands/check.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await runCheck({ inputs: [existingFilePath], json: false, failUnder: 50, noColor: true });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("exits with 1 when no schemas analyzed", async () => {
    mockDiscoverSchemas.mockResolvedValueOnce([]);

    const { runCheck } = await import("#src/cli/commands/check.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        runCheck({ inputs: [existingFilePath], json: false, failUnder: 80, noColor: true }),
      ).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ─── diagnoseSchema branch coverage via runCheck with mocked discoverSchemas ─

describe("runCheck — schema type coverage", () => {
  const existingFilePath = path.join(fixturesDir, "simple-schema.ts");
  const realModule = vi.importActual<typeof import("#src/discovery.js")>("#src/discovery.js");

  beforeEach(async () => {
    const { discoverSchemas: real } = await realModule;
    mockDiscoverSchemas.mockImplementation(real);
  });

  async function runWithSchema(schema: z.ZodType, exportName = "testSchema") {
    mockDiscoverSchemas.mockResolvedValueOnce([{ exportName, schema }]);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());
    try {
      const { runCheck } = await import("#src/cli/commands/check.js");
      await runCheck({ inputs: [existingFilePath], ...defaultOpts });
    } finally {
      consoleSpy.mockRestore();
    }
  }

  // ── Compilable IR types ──

  it("traverses array schema", async () => {
    await runWithSchema(z.array(z.string()));
  });

  it("traverses optional schema", async () => {
    await runWithSchema(z.string().optional());
  });

  it("traverses nullable schema", async () => {
    await runWithSchema(z.string().nullable());
  });

  it("traverses readonly schema", async () => {
    await runWithSchema(z.readonly(z.string()));
  });

  it("traverses default schema", async () => {
    await runWithSchema(z.string().default("x"));
  });

  it("traverses catch schema", async () => {
    await runWithSchema(z.string().catch("x"));
  });

  it("traverses union schema", async () => {
    await runWithSchema(z.union([z.string(), z.number()]));
  });

  it("traverses discriminatedUnion schema", async () => {
    await runWithSchema(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("a"), value: z.string() }),
        z.object({ type: z.literal("b"), count: z.number() }),
      ]),
    );
  });

  it("traverses tuple schema", async () => {
    await runWithSchema(z.tuple([z.string(), z.number()]));
  });

  it("traverses tuple with rest schema", async () => {
    await runWithSchema(z.tuple([z.string()]).rest(z.number()));
  });

  it("traverses record schema", async () => {
    await runWithSchema(z.record(z.string(), z.number()));
  });

  it("traverses intersection schema", async () => {
    await runWithSchema(z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })));
  });

  it("traverses set schema", async () => {
    await runWithSchema(z.set(z.string()));
  });

  it("traverses map schema", async () => {
    await runWithSchema(z.map(z.string(), z.number()));
  });

  it("traverses pipe schema", async () => {
    await runWithSchema(z.string().pipe(z.string().min(3)));
  });

  // ── Fallback paths (diagnostic only — no exit without --fail-under) ──

  it("reports fallback in nested array element", async () => {
    await runWithSchema(z.array(z.string().transform((s) => s.toUpperCase())));
  });

  it("reports fallback in union option", async () => {
    await runWithSchema(z.union([z.string(), z.string().transform((s) => s.toUpperCase())]));
  });

  it("reports fallback in tuple item", async () => {
    await runWithSchema(z.tuple([z.string(), z.string().transform((s) => s)]));
  });

  it("reports fallback in tuple rest", async () => {
    await runWithSchema(z.tuple([z.string()]).rest(z.string().transform((s) => s)));
  });

  it("reports fallback in record value", async () => {
    await runWithSchema(
      z.record(
        z.string(),
        z.string().transform((s) => s),
      ),
    );
  });

  it("reports fallback in intersection", async () => {
    await runWithSchema(
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.string().transform((s) => s) })),
    );
  });

  it("reports fallback in set element", async () => {
    await runWithSchema(z.set(z.string().transform((s) => s)));
  });

  it("reports fallback in map value", async () => {
    await runWithSchema(
      z.map(
        z.string(),
        z.string().transform((s) => s),
      ),
    );
  });

  it("reports fallback in pipe", async () => {
    await runWithSchema(
      z
        .string()
        .transform((s) => s)
        .pipe(z.string()),
    );
  });

  // ── Edge cases ──

  it("reports top-level fallback", async () => {
    await runWithSchema(z.string().transform((s) => s));
  });

  it("handles empty object as 100% compiled", async () => {
    await runWithSchema(z.object({}));
  });

  it("exits with error when discoverSchemas throws", async () => {
    mockDiscoverSchemas.mockRejectedValueOnce(new Error("load failed"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      const { runCheck } = await import("#src/cli/commands/check.js");
      await expect(runCheck({ inputs: [existingFilePath], ...defaultOpts })).rejects.toThrow(
        "process.exit",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("logs extraction error and continues to next schema", async () => {
    // Pass null as schema — extractSchema will throw when accessing _zod.def
    mockDiscoverSchemas.mockResolvedValueOnce([
      { exportName: "goodSchema", schema: z.string() },
      { exportName: "badSchema", schema: null as never },
    ]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(vi.fn());

    try {
      const { runCheck } = await import("#src/cli/commands/check.js");
      await runCheck({ inputs: [existingFilePath], ...defaultOpts });
      const errorOutput = errorSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(errorOutput).toContain("badSchema");
    } finally {
      consoleSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

// ─── Multiple file inputs ─────────────────────────────────────────────────────

describe("runCheck — multiple files", () => {
  const realModule = vi.importActual<typeof import("#src/discovery.js")>("#src/discovery.js");

  beforeEach(async () => {
    const { discoverSchemas: real } = await realModule;
    mockDiscoverSchemas.mockImplementation(real);
  });

  it("processes multiple file inputs", async () => {
    const { runCheck } = await import("#src/cli/commands/check.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await runCheck({
        inputs: [
          path.join(fixturesDir, "simple-schema.ts"),
          path.join(fixturesDir, "multi-schema.ts"),
        ],
        ...defaultOpts,
      });
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("simple-schema.ts");
      expect(output).toContain("multi-schema.ts");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("JSON report contains entries for multiple files", async () => {
    const { runCheck } = await import("#src/cli/commands/check.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await runCheck({
        inputs: [
          path.join(fixturesDir, "simple-schema.ts"),
          path.join(fixturesDir, "multi-schema.ts"),
        ],
        json: true,
        failUnder: undefined,
        noColor: true,
        autoDiscover: false,
      });
      const jsonOutput = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1]?.[0] as string;
      const report = JSON.parse(jsonOutput);
      expect(report).toHaveLength(2);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

// ─── --fail-under + --json combination ────────────────────────────────────────

describe("runCheck --fail-under + --json", () => {
  const existingFilePath = path.join(fixturesDir, "simple-schema.ts");
  const realModule = vi.importActual<typeof import("#src/discovery.js")>("#src/discovery.js");

  beforeEach(async () => {
    const { discoverSchemas: real } = await realModule;
    mockDiscoverSchemas.mockImplementation(real);
  });

  it("outputs JSON and exits with 1 when below threshold", async () => {
    // Use superRefine (non-compilable) to ensure fallback and coverage < 100%
    mockDiscoverSchemas.mockResolvedValueOnce([
      {
        exportName: "testSchema",
        schema: z.object({
          name: z.string(),
          slug: z.string().superRefine((val, ctx) => {
            if (val.length < 1) ctx.addIssue({ code: "custom", message: "too short" });
          }),
        }),
      },
    ]);

    const { runCheck } = await import("#src/cli/commands/check.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        runCheck({ inputs: [existingFilePath], json: true, failUnder: 100, noColor: true }),
      ).rejects.toThrow("process.exit");

      // Should still output valid JSON
      const jsonOutput = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1]?.[0] as string;
      const report = JSON.parse(jsonOutput);
      expect(Array.isArray(report)).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("exits with 1 in JSON mode when no schemas analyzed", async () => {
    mockDiscoverSchemas.mockResolvedValueOnce([]);

    const { runCheck } = await import("#src/cli/commands/check.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        runCheck({ inputs: [existingFilePath], json: true, failUnder: 80, noColor: true }),
      ).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
