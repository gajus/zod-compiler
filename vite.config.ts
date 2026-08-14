import * as path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";
import { defineConfig } from "vite-plus";
import { ALL_HELPER_NAMES, RUNTIME_SOURCE } from "./src/unplugin/virtual.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Ships the lean-mode runtime as a real module at `dist/runtime.js`.
 *
 * Lean-mode output imports its shared helpers from one module so a bundle holds
 * one copy. Hosts with resolve hooks answer that import from memory, but a
 * webpack loader (Turbopack) has none — for it the specifier has to resolve as
 * an ordinary package subpath, which means a file on disk.
 *
 * Emitted rather than committed: the source comes from the same decl registries
 * inline mode emits, so there is one producer and no second copy to drift. It
 * has to land during the build, not after, because publint checks every
 * `exports` target before the build finishes. A one-shot build is the only thing
 * this covers — `vp pack --watch` reuses the source captured when the config was
 * evaluated, so a registry edit needs a full rebuild to reach dist.
 */
function emitRuntimeModule() {
  const declarations = [
    "// Generated at build time from zod-compiler's helper registries.",
    "// Imported by lean-mode generated code, never written by hand — `any`",
    "// because a caller would otherwise have to cast every helper to call it.",
    ...ALL_HELPER_NAMES.map((name) => `export declare const ${name}: any;`),
  ].join("\n");

  return {
    name: "zod-compiler:emit-runtime",
    generateBundle(this: { emitFile: (file: Record<string, string>) => void }) {
      this.emitFile({ type: "asset", fileName: "runtime.js", source: `${RUNTIME_SOURCE}\n` });
      this.emitFile({ type: "asset", fileName: "runtime.d.ts", source: `${declarations}\n` });
    },
  };
}

/** Keep the editor schema in lockstep with the register config type on every package build. */
function generateRegisterSchema() {
  return {
    name: "zod-compiler:generate-register-schema",
    buildStart() {
      const schema = createGenerator({
        path: path.resolve(__dirname, "src/register/config.ts"),
        tsconfig: path.resolve(__dirname, "tsconfig.json"),
        type: "ZodCompilerRegisterConfig",
        topRef: false,
      }).createSchema("ZodCompilerRegisterConfig");
      fs.writeFileSync(
        path.resolve(__dirname, "schema.json"),
        `${JSON.stringify(schema, null, 2)}\n`,
      );
    },
  };
}

export default defineConfig({
  resolve: {
    conditions: ["source"],
    // Explicit alias: the test pipeline does not reliably honor custom
    // conditions for `#`-subpath imports, and the package-imports fallback
    // would resolve #src through a (possibly stale) dist build.
    alias: {
      "#src": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
    },
    server: {
      deps: {
        inline: ["zod"],
      },
    },
  },
  pack: {
    entry: ["src/**/*.ts"],
    plugins: [generateRegisterSchema(), emitRuntimeModule()],
    format: ["esm"],
    unbundle: true,
    sourcemap: true,
    dts: {
      sourcemap: true,
    },
    fixedExtension: false,
    target: "es2022",
    deps: {
      neverBundle: true,
    },
    logLevel: "warn",
    publint: true,
    report: false,
  },
  run: {
    tasks: {
      ci: {
        command: ["vp pack", "vp check", "knip", "vp test"],
        input: [
          { auto: true },
          "!.tmp/**",
          "!.vite-hooks",
          "!.vite-hooks/**",
          "!coverage",
          "!coverage/**",
          "!node_modules/.cache/**",
          "!node_modules/.modules.yaml",
          "!node_modules/.vite/vitest",
          "!node_modules/.vite/vitest/**",
          "!**/.next",
          "!**/.next/**",
          "!tests/fixtures/.*",
          "!tests/fixtures/.*/**",
          "!tests/fixtures/__*",
          "!tests/fixtures/__*/**",
        ],
        output: [
          { auto: true },
          "!.tmp/**",
          "!.vite-hooks",
          "!.vite-hooks/**",
          "!coverage",
          "!coverage/**",
          "!node_modules/.cache/**",
          "!node_modules/.modules.yaml",
          "!node_modules/.vite/vitest",
          "!node_modules/.vite/vitest/**",
          "!**/.next",
          "!**/.next/**",
          "!tests/fixtures/.*",
          "!tests/fixtures/.*/**",
          "!tests/fixtures/__*",
          "!tests/fixtures/__*/**",
        ],
      },
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    useTabs: false,
    tabWidth: 2,
    printWidth: 100,
    singleQuote: false,
    jsxSingleQuote: false,
    quoteProps: "as-needed",
    trailingComma: "all",
    semi: true,
    arrowParens: "always",
    bracketSameLine: false,
    bracketSpacing: true,
    ignorePatterns: [
      "node_modules",
      "dist",
      "**/dist",
      "coverage",
      "schema.json",
      "*.compiled.ts",
      "*.compiled.js",
      ".agents",
      ".claude",
      "**/.next",
    ],
  },
  lint: {
    plugins: ["import", "typescript", "unicorn", "oxc", "promise"],
    categories: {
      correctness: "error",
    },
    rules: {
      "no-unused-vars": "error",
      "no-undef": "off",
      "typescript/no-explicit-any": "error",
      "no-empty": "error",
      "no-console": "warn",
      "no-var": "error",
      "import/no-cycle": "warn",
      "prefer-const": "error",
      "typescript/consistent-type-imports": [
        "error",
        {
          disallowTypeAnnotations: false,
        },
      ],
      "no-param-reassign": "error",
      "typescript/no-non-null-assertion": "warn",
      "typescript/no-namespace": "error",
      "no-else-return": "warn",
      "typescript/prefer-as-const": "error",
      "unicorn/no-static-only-class": "warn",
      "typescript/no-useless-empty-export": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/no-implied-eval": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      {
        files: ["src/**", "tests/**"],
        rules: {
          "import/no-nodejs-modules": "error",
        },
      },
      {
        files: [
          "src/cli/**",
          "src/loader.ts",
          "src/register/**",
          "src/swc.ts",
          "src/turbopack.ts",
          "src/static-filter.ts",
          "tests/cli/**",
          "tests/discovery.test.ts",
          "tests/loader.test.ts",
          "tests/register.test.ts",
          "tests/swc.test.ts",
          "tests/turbopack.test.ts",
          "src/unplugin/**",
          "tests/unplugin/**",
          "tests/zod-version.ts",
        ],
        rules: {
          "import/no-nodejs-modules": "off",
        },
      },
      {
        files: ["src/core/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["#src/cli/**", "#src/unplugin/**", "#src/discovery.*", "#src/loader.*"],
                  message: "core/ must not depend on cli/, unplugin/, discovery, or loader",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["src/cli/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["#src/unplugin/**"],
                  message: "cli/ must not depend on unplugin/",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["src/unplugin/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["#src/cli/**"],
                  message: "unplugin/ must not depend on cli/",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/hono/**"],
        globals: {
          Bun: "readonly",
        },
      },
    ],
    ignorePatterns: [
      "node_modules",
      "dist",
      "**/dist",
      "**/*.compiled.ts",
      "**/*.compiled.js",
      "**/.next",
      "smoke/node_modules",
      "tests/fixtures",
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
});
