import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { WatchDeps } from "#src/cli/commands/watch.js";
import { debounce, isWatchTarget, resolveWatchDirs, runWatch } from "#src/cli/commands/watch.js";
import { resolveOutputPath } from "#src/cli/emitter.js";

const fixturesDir = path.resolve(import.meta.dirname, "../../fixtures");
const tmpOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), "zod-compiler-watch-test-"));
const outputFiles: string[] = [];

afterEach(async () => {
  for (const f of outputFiles) {
    await fs.promises.unlink(f).catch(() => undefined);
  }
  outputFiles.length = 0;
});

afterAll(async () => {
  await fs.promises.rm(tmpOutputDir, { recursive: true, force: true });
});

describe("isWatchTarget", () => {
  it("accepts .ts files", () => {
    expect(isWatchTarget("src/schemas.ts")).toBe(true);
  });

  it("accepts .mts files", () => {
    expect(isWatchTarget("src/schemas.mts")).toBe(true);
  });

  it("accepts .js files", () => {
    expect(isWatchTarget("src/schemas.js")).toBe(true);
  });

  it("accepts .mjs files", () => {
    expect(isWatchTarget("src/schemas.mjs")).toBe(true);
  });

  it("rejects .compiled.ts files", () => {
    expect(isWatchTarget("src/schemas.compiled.ts")).toBe(false);
  });

  it("rejects .compiled.js files", () => {
    expect(isWatchTarget("src/schemas.compiled.js")).toBe(false);
  });

  it("rejects .test.ts files", () => {
    expect(isWatchTarget("src/schemas.test.ts")).toBe(false);
  });

  it("rejects .test.js files", () => {
    expect(isWatchTarget("src/schemas.test.js")).toBe(false);
  });

  it("rejects .d.ts files", () => {
    expect(isWatchTarget("src/schemas.d.ts")).toBe(false);
  });

  it("rejects node_modules paths", () => {
    expect(isWatchTarget("node_modules/zod/index.ts")).toBe(false);
  });

  it("accepts paths with 'node_modules' as substring in directory name", () => {
    expect(isWatchTarget("/home/user/node_modules_backup/schema.ts")).toBe(true);
  });

  it("rejects nested node_modules paths", () => {
    expect(isWatchTarget("/project/node_modules/@scope/pkg/index.ts")).toBe(false);
  });

  it("rejects non-script files", () => {
    expect(isWatchTarget("src/styles.css")).toBe(false);
    expect(isWatchTarget("README.md")).toBe(false);
    expect(isWatchTarget("package.json")).toBe(false);
  });
});

describe("resolveWatchDirs", () => {
  const testsDir = path.resolve(import.meta.dirname, "../..");
  const cliDir = path.join(testsDir, "cli");
  const coreDir = path.join(testsDir, "core");

  it("resolves file inputs to parent directories", () => {
    const result = resolveWatchDirs([path.join(cliDir, "emitter.test.ts")]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(cliDir);
  });

  it("deduplicates subdirectories", () => {
    const result = resolveWatchDirs([testsDir, cliDir]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(testsDir);
  });

  it("keeps sibling directories", () => {
    const result = resolveWatchDirs([cliDir, coreDir]);
    expect(result).toHaveLength(2);
  });

  it("deduplicates identical directories", () => {
    const result = resolveWatchDirs([
      path.join(cliDir, "emitter.test.ts"),
      path.join(cliDir, "commands/watch.test.ts"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(cliDir);
  });

  it("falls back to parent dir for non-existent paths", () => {
    const result = resolveWatchDirs(["/nonexistent/dir/file.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("/nonexistent/dir");
  });
});

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays execution", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid calls", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    debounced();
    debounced();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes arguments through to the original function", () => {
    const fn = vi.fn<(a: string, b: number) => void>();
    const debounced = debounce(fn, 100);

    debounced("hello", 42);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith("hello", 42);
  });

  it("resets timer on each call", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(80);
    expect(fn).not.toHaveBeenCalled();

    debounced();
    vi.advanceTimersByTime(80);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("runWatch", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let mockLogger: {
    info: Mock<(msg: string) => void>;
    success: Mock<(msg: string) => void>;
    warn: Mock<(msg: string) => void>;
    error: Mock<(msg: string) => void>;
    dim: Mock<(msg: string) => void>;
  };

  beforeEach(async () => {
    const loggerMod = await import("#src/cli/logger.js");
    mockLogger = {
      info: vi.fn<(msg: string) => void>(),
      success: vi.fn<(msg: string) => void>(),
      warn: vi.fn<(msg: string) => void>(),
      error: vi.fn<(msg: string) => void>(),
      dim: vi.fn<(msg: string) => void>(),
    };
    logSpy = vi.spyOn(loggerMod, "logger", "get").mockReturnValue(mockLogger);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function createMockDeps(): {
    deps: WatchDeps;
    callbacks: Array<(event: string, filename: string | null) => void>;
  } {
    const callbacks: Array<(event: string, filename: string | null) => void> = [];
    const deps: WatchDeps = {
      createWatcher: (_dir, _opts, cb) => {
        callbacks.push(cb);
        return { close: vi.fn() } as unknown as fs.FSWatcher;
      },
    };
    return { deps, callbacks };
  }

  it("performs initial generation and starts watching", async () => {
    const { deps } = createMockDeps();
    const filePath = path.join(fixturesDir, "simple-schema.ts");
    outputFiles.push(resolveOutputPath(filePath, `${tmpOutputDir}/`));

    const watchPromise = runWatch({ inputs: [filePath], output: `${tmpOutputDir}/` }, deps);

    try {
      await vi.waitFor(() => {
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Watching"));
      });

      expect(mockLogger.success).toHaveBeenCalledWith(expect.stringContaining("validateUser"));
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Generated 1 schema"));
    } finally {
      process.emit("SIGINT", "SIGINT");
      await watchPromise;
    }

    expect(mockLogger.dim).toHaveBeenCalledWith(expect.stringContaining("Stopping"));
  });

  it("exits when input path does not exist", async () => {
    const { deps } = createMockDeps();
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        runWatch({ inputs: ["/nonexistent/path.ts"], output: undefined }, deps),
      ).rejects.toThrow("process.exit");
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      mockExit.mockRestore();
    }
  });

  it("warns when no compile() calls found in files", async () => {
    const { deps } = createMockDeps();
    const filePath = path.join(fixturesDir, "no-compile.ts");

    const watchPromise = runWatch({ inputs: [filePath], output: undefined }, deps);

    try {
      await vi.waitFor(() => {
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Watching"));
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("No compile() calls found"),
      );
    } finally {
      process.emit("SIGINT", "SIGINT");
      await watchPromise;
    }
  });

  it("handles SIGTERM for graceful shutdown", async () => {
    const { deps } = createMockDeps();
    const filePath = path.join(fixturesDir, "simple-schema.ts");
    outputFiles.push(resolveOutputPath(filePath, `${tmpOutputDir}/`));

    const watchPromise = runWatch({ inputs: [filePath], output: `${tmpOutputDir}/` }, deps);

    try {
      await vi.waitFor(() => {
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Watching"));
      });
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await watchPromise;
    }

    expect(mockLogger.dim).toHaveBeenCalledWith(expect.stringContaining("Stopping"));
  });

  it("ignores watcher callback with null filename", async () => {
    const { deps, callbacks } = createMockDeps();
    const filePath = path.join(fixturesDir, "simple-schema.ts");
    outputFiles.push(resolveOutputPath(filePath, `${tmpOutputDir}/`));

    const watchPromise = runWatch({ inputs: [filePath], output: `${tmpOutputDir}/` }, deps);

    try {
      await vi.waitFor(() => {
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Watching"));
      });
      mockLogger.success.mockClear();

      // Trigger with null filename — should be silently ignored
      callbacks[0]?.("change", null);

      // Give it a moment, then verify no regeneration occurred
      await new Promise((r) => setTimeout(r, 300));
      expect(mockLogger.success).not.toHaveBeenCalled();
    } finally {
      process.emit("SIGINT", "SIGINT");
      await watchPromise;
    }
  });

  it("ignores watcher callback for non-target files", async () => {
    const { deps, callbacks } = createMockDeps();
    const filePath = path.join(fixturesDir, "simple-schema.ts");
    outputFiles.push(resolveOutputPath(filePath, `${tmpOutputDir}/`));

    const watchPromise = runWatch({ inputs: [filePath], output: `${tmpOutputDir}/` }, deps);

    try {
      await vi.waitFor(() => {
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Watching"));
      });
      mockLogger.success.mockClear();

      // Trigger with non-schema file — should be ignored
      callbacks[0]?.("change", "styles.css");

      await new Promise((r) => setTimeout(r, 300));
      expect(mockLogger.success).not.toHaveBeenCalled();
    } finally {
      process.emit("SIGINT", "SIGINT");
      await watchPromise;
    }
  });

  it("logs error when all watchers fail to start", async () => {
    const deps: WatchDeps = {
      createWatcher: () => {
        throw new Error("permission denied");
      },
    };
    const filePath = path.join(fixturesDir, "simple-schema.ts");
    outputFiles.push(resolveOutputPath(filePath, `${tmpOutputDir}/`));

    await runWatch({ inputs: [filePath], output: `${tmpOutputDir}/` }, deps);

    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("Failed to watch"));
    expect(mockLogger.error).toHaveBeenCalledWith("No directories could be watched.");
  });

  it("regenerates on watcher callback", async () => {
    const { deps, callbacks } = createMockDeps();
    const filePath = path.join(fixturesDir, "simple-schema.ts");
    outputFiles.push(resolveOutputPath(filePath, `${tmpOutputDir}/`));

    const watchPromise = runWatch({ inputs: [filePath], output: `${tmpOutputDir}/` }, deps);

    try {
      // Wait for initial generation to complete and watcher to start
      await vi.waitFor(() => {
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Watching"));
      });
      mockLogger.success.mockClear();

      // Fire watcher callback directly — no real fs.watch event needed
      callbacks[0]?.("change", "simple-schema.ts");

      // Wait for debounced regeneration (150ms debounce + async file processing)
      await vi.waitFor(
        () => {
          expect(mockLogger.success).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );
    } finally {
      process.emit("SIGINT", "SIGINT");
      await watchPromise;
    }
  });
});
