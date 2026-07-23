import type { ModifyRspackConfigFn, RsbuildPluginAPI } from "@rsbuild/core";
import { describe, expect, it } from "vitest";
import zodCompiler from "#src/unplugin/rsbuild.js";

describe("rsbuild plugin", () => {
  it("installs the rspack adapter", async () => {
    const modifiers: ModifyRspackConfigFn[] = [];
    const plugin = zodCompiler({ cache: false });
    const api = {
      modifyRspackConfig(modifier: ModifyRspackConfigFn) {
        modifiers.push(modifier);
      },
    } as unknown as RsbuildPluginAPI;

    await plugin.setup(api);

    expect(plugin.name).toBe("zod-compiler");
    expect(modifiers).toHaveLength(1);

    const config = { plugins: [] };
    await modifiers[0]?.(config, {} as never);

    expect(config.plugins).toHaveLength(1);
  });
});
