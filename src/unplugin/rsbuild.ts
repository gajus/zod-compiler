import type { RsbuildPlugin } from "@rsbuild/core";
import type { ZodCompilerPluginOptions } from "./types.js";
import zodCompilerRspack from "./rspack.js";

export default function zodCompiler(options?: ZodCompilerPluginOptions): RsbuildPlugin {
  return {
    name: "zod-compiler",
    setup(api) {
      api.modifyRspackConfig((config) => {
        config.plugins ??= [];
        config.plugins.push(zodCompilerRspack(options));
      });
    },
  };
}
