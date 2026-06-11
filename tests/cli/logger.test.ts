import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Colors, createColors } from "#src/cli/logger.js";

describe("createColors", () => {
  it("returns ANSI codes when enabled", () => {
    const c = createColors(true);
    expect(c.reset).toBe("\x1b[0m");
    expect(c.red).toBe("\x1b[31m");
    expect(c.green).toBe("\x1b[32m");
    expect(c.yellow).toBe("\x1b[33m");
    expect(c.cyan).toBe("\x1b[36m");
    expect(c.dim).toBe("\x1b[2m");
    expect(c.bold).toBe("\x1b[1m");
  });

  it("returns empty strings when disabled", () => {
    const c = createColors(false);
    const keys: (keyof Colors)[] = ["reset", "red", "green", "yellow", "cyan", "dim", "bold"];
    for (const key of keys) {
      expect(c[key]).toBe("");
    }
  });
});

describe("logger", () => {
  // logger captures console.log/console.error at module load time,
  // so we must reset the module cache and spy BEFORE re-importing.

  beforeEach(() => {
    vi.resetModules();
  });

  it("info writes cyan-prefixed message to stdout", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(vi.fn());
    try {
      const { logger } = await import("#src/cli/logger.js");
      logger.info("test message");
      expect(spy).toHaveBeenCalledTimes(1);
      const output = spy.mock.calls[0]?.[0] as string;
      expect(output).toContain("info");
      expect(output).toContain("test message");
    } finally {
      spy.mockRestore();
    }
  });

  it("success writes green-prefixed message to stdout", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(vi.fn());
    try {
      const { logger } = await import("#src/cli/logger.js");
      logger.success("done msg");
      expect(spy).toHaveBeenCalledTimes(1);
      const output = spy.mock.calls[0]?.[0] as string;
      expect(output).toContain("done");
      expect(output).toContain("done msg");
    } finally {
      spy.mockRestore();
    }
  });

  it("warn writes to stderr", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(vi.fn());
    try {
      const { logger } = await import("#src/cli/logger.js");
      logger.warn("warning msg");
      expect(spy).toHaveBeenCalledTimes(1);
      const output = spy.mock.calls[0]?.[0] as string;
      expect(output).toContain("warn");
      expect(output).toContain("warning msg");
    } finally {
      spy.mockRestore();
    }
  });

  it("error writes to stderr", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(vi.fn());
    try {
      const { logger } = await import("#src/cli/logger.js");
      logger.error("error msg");
      expect(spy).toHaveBeenCalledTimes(1);
      const output = spy.mock.calls[0]?.[0] as string;
      expect(output).toContain("error");
      expect(output).toContain("error msg");
    } finally {
      spy.mockRestore();
    }
  });

  it("dim wraps message in dim formatting", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(vi.fn());
    try {
      const { logger } = await import("#src/cli/logger.js");
      logger.dim("dim msg");
      expect(spy).toHaveBeenCalledTimes(1);
      const output = spy.mock.calls[0]?.[0] as string;
      expect(output).toContain("dim msg");
    } finally {
      spy.mockRestore();
    }
  });
});
