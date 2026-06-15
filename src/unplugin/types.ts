import type { CodegenMode } from "../core/codegen/context.js";
import type { HoistOptions } from "./hoist.js";

export interface TransformOptions {
  mode: CodegenMode;
  runtimeId?: string;
  zodCompat?: boolean | undefined;
  verbose?: boolean | undefined;
  autoDiscover?: boolean | undefined;
  hoist?: boolean | HoistOptions | undefined;
  onBuildStats?: (stats: BuildStats) => void;
  /** Fired when discovery (file execution) is about to run — used by the disk cache to decide which results are worth persisting. */
  onDiscovery?: () => void;
  /**
   * Fired when the transform did parse-level work short of discovery (hoist
   * source scan, static export filter). The disk cache persists even null
   * results for these files: re-deriving "no transform needed" costs a full
   * scan per zod-importing file per run (a field report measured 35.8s/run
   * of hoist scans in hoist-only mode, all producing never-cached nulls).
   * Purely textual bail-outs never fire this — caching those would trade a
   * substring check for a disk entry per source file in the project.
   */
  onSubstantialWork?: () => void;
}

export interface BuildStats {
  files: number;
  schemas: number;
  optimized: number;
  failed: number;
}

export class BuildStatsAccumulator implements BuildStats {
  files = 0;
  schemas = 0;
  optimized = 0;
  failed = 0;

  add(s: BuildStats): void {
    this.files += s.files;
    this.schemas += s.schemas;
    this.optimized += s.optimized;
    this.failed += s.failed;
  }

  reset(): void {
    this.files = 0;
    this.schemas = 0;
    this.optimized = 0;
    this.failed = 0;
  }
}

export interface ZodCompilerPluginOptions {
  /** Glob patterns to include (default: ["**\/*.ts", "**\/*.tsx"]) */
  include?: string[];
  /** Glob patterns to exclude (default: ["node_modules/**", "**\/*.d.ts"]) */
  exclude?: string[];
  /**
   * How schemas are found.
   *
   * - `"auto"` (default): every exported plain Zod schema compiles — no
   *   wrappers, no zod-compiler imports in source. Detection scans files
   *   with a runtime `import ... from "zod"`, statically pre-filters ones
   *   whose exports provably aren't schemas, and executes the remaining
   *   candidates to check exports for `_zod.def`. Also enables build-time
   *   compilation of hoisted in-function schemas (anonymous schemas like
   *   `sql.type(z.object(...))` — there is no exported name to opt in with).
   * - `"explicit"`: only schemas wrapped in `compile()` from zod-compiler
   *   are compiled; build-time file execution is limited to files that
   *   import it. Hoisting still applies, but hoisted schemas stay plain Zod.
   *
   * **Note:** in `"auto"` mode, candidate files are executed at build time
   * via `loadSourceFile()`. Use `include` to limit scope if your project
   * has schema-shaped files with side effects.
   * @default "auto"
   */
  schemas?: "explicit" | "auto" | undefined;
  /**
   * What a compiled schema export evaluates to.
   *
   * - `"schema"` (default): the original Zod schema object with the compiled
   *   `parse`/`safeParse`/`parseAsync`/`safeParseAsync` installed as own
   *   properties — identity is preserved, so `.shape`, `.meta()`,
   *   `z.toJSONSchema()`, `instanceof`, Standard Schema, and libraries like
   *   @hono/zod-validator and tRPC keep working.
   * - `"bag"`: a minimal plain object with just the compiled methods —
   *   smaller bundles (the Zod construction can tree-shake away), but
   *   anything expecting a real Zod schema breaks.
   * @default "schema"
   */
  output?: "schema" | "bag" | undefined;
  /**
   * Enable verbose logging during build.
   * Logs per-schema compilation status and a build summary.
   * @default false
   */
  verbose?: boolean | undefined;
  /**
   * Hoist Zod schema construction out of function bodies to module scope
   * (the babel-plugin-zod-hoist optimization). A schema defined inside a
   * function — a React component, a request handler — is otherwise rebuilt
   * on every call:
   *
   * ```typescript
   * function getSchema() {
   *   return z.object({ name: z.string() });  // rebuilt per call
   * }
   * // becomes
   * const _zh_94b7f5c1 = z.object({ name: z.string() });
   * function getSchema() {
   *   return _zh_94b7f5c1;                     // built once
   * }
   * ```
   *
   * Only expressions built purely from imported bindings and literals are
   * hoisted — anything referencing local variables, module-level bindings,
   * `this`, or globals stays put (safe globals like `Number` are allowed
   * inside callbacks, which run per call regardless). Identical schemas
   * dedupe to one binding.
   *
   * Pass an object to configure `schemaNamePattern` (default `/ZodSchema$/`):
   * imported identifiers matching it are hoistable combinator-chain roots
   * even without an inline z.* reference (`UserZodSchema.partial()`). Set it
   * to `null` to disable name-based matching.
   * @default true
   */
  hoist?: boolean | { schemaNamePattern?: RegExp | string | null | undefined } | undefined;
  /**
   * **Vite only** (other bundlers ignore this option): when the plugin runs.
   *
   * By default the plugin compiles production builds **and test runs**
   * (Vitest is detected via the `VITEST` env var / `"test"` mode), so tests
   * exercise — and benefit from — the same compiled validators that ship.
   * Plain dev servers skip AOT compilation cost; `compile()` transparently
   * falls back to Zod's runtime validation there, so behavior stays correct.
   *
   * Set `"build"` to also skip tests, `"serve"` for dev/test-only, or
   * `"all"` to compile everywhere including the dev server.
   * @default builds + Vitest
   */
  apply?: "build" | "serve" | "all" | undefined;
  /**
   * Persistent transform-result cache (Node.js only).
   *
   * Schema discovery executes schema files (and their import graphs) inside
   * the bundler process; without a disk cache that cost is re-paid on every
   * `vitest run` / build even when nothing changed. Entries are validated
   * against content hashes of every first-party module the discovery
   * executed, so edits to a schema file *or any file it imports* invalidate
   * exactly as the in-memory watch invalidation does — but across processes.
   *
   * Caveat: module-scope dynamism in schema files (schemas derived from
   * `process.env`, `Date.now()`, …) is frozen until a watched source file
   * changes. Disable the cache for such setups.
   *
   * Pass a string to use a custom cache directory.
   * @default true (node_modules/.cache/zod-compiler)
   */
  cache?: boolean | string | undefined;
}
