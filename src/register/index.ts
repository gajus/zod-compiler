import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "es-module-lexer";
import type { ZodType } from "zod";
import { isCompiledSchema } from "../core/compile.js";
import { jit, jitAll, type JitOptions } from "../jit.js";
import type { ZodCompilerRegisterConfig } from "./config.js";
import { decodeModuleSource, instrumentModule, isRegisterFormat } from "./transform.js";

const CONFIG_FILE = "zod-compiler.json";
const REGISTER_SYMBOL = Symbol.for("zod-compiler:register");

await init;

const config = loadConfig();
const jitOptions: JitOptions = {
  eager: config.eager,
  output: config.output,
};

Object.defineProperty(globalThis, REGISTER_SYMBOL, {
  configurable: true,
  value(value: unknown, flatten = false): unknown {
    registerValue(value);
    if (flatten && typeof value === "object" && value !== null) {
      for (const exported of Object.values(value)) registerValue(exported);
    }
    return value;
  },
});

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith("file:") || !isRegisterFormat(loaded.format) || loaded.source == null) {
      return loaded;
    }

    // Posix separators, because the include/exclude globs are matched with
    // picomatch and the plugin paths it was written against are bundler ids,
    // which are already normalized. `fileURLToPath` is the only caller that
    // yields native separators, so on Windows `include: ["src/**"]` matched
    // nothing and the whole feature went silently inert.
    const filename = fileURLToPath(url).replaceAll("\\", "/");
    const source = decodeModuleSource(loaded.source);
    // This hook runs for EVERY module the process loads, and what it adds is
    // only an optimization. So nothing it does may fail a load: a config value
    // of the wrong shape, a lexer that chokes on a dialect it half-supports, a
    // bad `hoist.schemaNamePattern` — each would otherwise surface as a crash
    // at startup, in someone else's file, naming zod-compiler internals. Ship
    // the module unchanged instead and leave its schemas uncompiled.
    let transformed: string | null;
    try {
      transformed = instrumentModule(source, filename, loaded.format, config);
    } catch {
      return loaded;
    }
    return transformed === null ? loaded : { ...loaded, source: transformed };
  },
});

function registerValue(value: unknown): void {
  if (config.schemas === "explicit") {
    if (isCompiledSchema(value)) jit(value as unknown as ZodType, jitOptions);
  } else {
    jitAll({ value }, jitOptions);
  }
}

function loadConfig(): ZodCompilerRegisterConfig {
  const filename = path.resolve(CONFIG_FILE);
  let source: string;
  try {
    source = fs.readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new SyntaxError(`Cannot parse ${filename}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${filename} must contain a JSON object`);
  }
  return value as ZodCompilerRegisterConfig;
}
