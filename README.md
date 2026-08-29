# zod-compiler

**Compile Zod schemas into zero-overhead validation functions at build time.**

Keep your existing Zod schemas. Get **1.1-46x faster** validation, and up to **41x** on rejected
input. No code changes required.

Requires **Zod ≥ 4.5**. The compiled output reproduces 4.5's semantics exactly — code-point string
lengths, symbol-keyed shapes, tuple issue order — so it does not match earlier 4.x releases. Stay on
zod-compiler 1.x if you are on Zod 4.0–4.4.

- [What Gets Compiled](#what-gets-compiled)
- [Schema Hoisting](#schema-hoisting)
- [Benchmark](#benchmark)

> [!NOTE]
> zod-compiler has been tested to work in large projects with tens of thousands of Zod schemas.

## Usage

Five ways to use zod-compiler — pick one:

### 1. Automatic Mode (Default)

The plugin detects and compiles every exported Zod schema at build time. No wrappers, no imports from `zod-compiler` in your source.

**vite.config.ts:**

```typescript
import zodCompiler from "zod-compiler/vite";

export default defineConfig({
  plugins: [zodCompiler()],
});
```

**Your schema file stays pure Zod:**

```typescript
// src/schemas.ts
import { z } from "zod";

export const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.email(),
  role: z.enum(["admin", "editor", "viewer"]),
});
```

Use them as usual. Methods are installed on the original schema object, so `.shape`, `._zod`, Standard
Schema, `instanceof` and `z.toJSONSchema()` keep working.

Compiled schemas also expose **`.is(input): input is T`** — a zero-allocation drop-in for
`safeParse(x).success`.

### 2. compile() (Explicit)

If you prefer explicit opt-in, wrap specific schemas with `compile()`:

```typescript
import { z } from "zod";
import { compile } from "zod-compiler";

const UserSchema = z.object({
  name: z.string().min(3),
  email: z.email(),
});

export const validateUser = compile(UserSchema);

// In dev: falls back to Zod's runtime validation
// After build: uses AOT-compiled optimized code
validateUser.parse(data);
validateUser.safeParse(data);
```

`compile()` and auto mode coexist. Pair with `schemas: "explicit"` to make `compile()` the _only_ path — no automatic detection, no build-time execution of plain schema files.

### 3. CLI (No Bundler)

Generate optimized validation files from the command line:

```bash
# Single file
npx zod-compiler generate src/schemas.ts -o src/schemas.compiled.ts

# Directory
npx zod-compiler generate src/ -o src/compiled/

# Watch mode
npx zod-compiler generate src/ --watch

# Only compile() calls (skip plain exports); minimal methods-only output
npx zod-compiler generate src/ --schemas explicit --emit bag

# Compact output: fast path only, cold errors delegated to Zod (~70% smaller)
npx zod-compiler generate src/ --emit compact
```

### 4. Runtime Compilation (No Build Step)

`jit()` runs the same pipeline in-process, for `tsx`, `ts-node`, Jest — anywhere no plugin fires:

```typescript
import { jit } from "zod-compiler/jit";

export const UserSchema = jit(z.object({ name: z.string().min(1), email: z.email() }));
```

Same validators a build emits, installed on the schema object, so Zod interop is unchanged.
Compilation is lazy — 0.1-0.3 ms on a schema's first parse; `{ eager: true }` compiles up front,
`jitAll(namespace)` takes a whole module.

The cost is the import: ~570 KB of codegen and `acorn`, **~10 ms of module load**. That suits a
long-lived process, not a CLI, a cold serverless handler or a browser — use the build plugin there.
Libraries should ship plain Zod and let the app decide.

Needs `new Function`, as Zod's own object fast-path does. `z.config({ jitless: true })` and a CSP
that blocks eval both leave a working plain-Zod schema.

### 5. Node.js Register Hook

Node.js 22.15+ can automatically insert the equivalent of `jit()` for exported schemas as modules
load, with no source changes and no bundler:

```bash
node --import zod-compiler/register src/server.js
```

The same preload handles ESM imports, CommonJS `require()`, and Node's native TypeScript formats. It
also chains with TypeScript runners:

```bash
node --import zod-compiler/register --import tsx src/server.ts
```

This is runtime JIT instrumentation, not the AOT source rewriting performed by the Vite, Rsbuild, and
other build plugins. The hook identifies exported schema bindings and registers their live Zod objects;
validators are generated in-process, lazily on first use. It does not execute modules twice and adds no
transform cache beyond Node's module cache. Use a build plugin or the CLI when generated validator code
must exist before Node starts or runtime `new Function` is unavailable.

Optional settings come from `zod-compiler.json` in the working directory:

```json
{
  "$schema": "./node_modules/zod-compiler/schema.json",
  "include": ["src/**"],
  "exclude": ["**/*.test.ts"],
  "schemas": "auto",
  "eager": false,
  "output": "schema",
  "hoist": true
}
```

`output: "compact"` preserves the Zod schema and compiled valid-input fast path while delegating cold
error production to Zod. Full `"schema"` output remains the default. `"bag"` is unavailable because a
load hook cannot replace already-linked ESM export bindings safely.

## Build Plugin

### Supported Build Tools

| Build Tool          | Import                                            |
| ------------------- | ------------------------------------------------- |
| Vite                | `import zodCompiler from "zod-compiler/vite"`     |
| webpack             | `import zodCompiler from "zod-compiler/webpack"`  |
| Turbopack / Next.js | `loaders: ["zod-compiler/turbopack"]`             |
| esbuild             | `import zodCompiler from "zod-compiler/esbuild"`  |
| SWC                 | `import zodCompiler from "zod-compiler/swc"`      |
| Rollup              | `import zodCompiler from "zod-compiler/rollup"`   |
| Rolldown            | `import zodCompiler from "zod-compiler/rolldown"` |
| Rsbuild             | `import zodCompiler from "zod-compiler/rsbuild"`  |
| rspack              | `import zodCompiler from "zod-compiler/rspack"`   |
| Bun                 | `import zodCompiler from "zod-compiler/bun"`      |
| Farm                | `import zodCompiler from "zod-compiler/farm"`     |

Turbopack takes a loader rather than a plugin — see [Next.js (Turbopack)](#nextjs-turbopack). Metro
has neither — see [React Native / Expo](#react-native--expo).

### Options

| Option        | Type                             | Default         | Description                                                                                                 |
| ------------- | -------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `schemas`     | `"auto" \| "explicit"`           | `"auto"`        | `"auto"` compiles every exported schema (and hoisted in-function ones); `"explicit"` only `compile()` calls |
| `include`     | `string[]`                       | —               | Only process files matching these path globs                                                                |
| `exclude`     | `string[]`                       | —               | Skip files matching these path globs                                                                        |
| `output`      | `"schema" \| "bag" \| "compact"` | `"schema"`      | What a compiled export evaluates to — see [Compact Output](#compact-output-output-compact)                  |
| `verbose`     | `boolean`                        | `false`         | Log per-schema compilation status                                                                           |
| `hoist`       | `boolean`                        | `true`          | Move schemas built inside functions to module scope — see [Schema Hoisting](#schema-hoisting)               |
| `apply`       | `"build" \| "serve" \| "all"`    | builds + Vitest | **Vite only**: when the plugin runs                                                                         |
| `codegenMode` | `"lean" \| "inline"`             | auto            | `"inline"` emits helpers per file; needed for transpile-only esbuild — see [SWC](#swc)                      |
| `cache`       | `boolean \| string`              | `true`          | Persistent transform cache in `node_modules/.cache/zod-compiler`                                            |
| `parallel`    | `boolean \| number`              | `false`         | Run transforms on worker threads — see [Parallel Transforms](#parallel-transforms)                          |

```typescript
zodCompiler({
  include: ["src/schemas"],
  verbose: true,
});
```

**rsbuild.config.ts:**

```typescript
import { defineConfig } from "@rsbuild/core";
import zodCompiler from "zod-compiler/rsbuild";

export default defineConfig({
  plugins: [zodCompiler()],
});
```

> **Note:** Vitest is detected automatically (via the `VITEST` env var), so
> tests compile and exercise the same validators that ship to production —
> including their performance. Pass `apply: "build"` if you want tests to use
> the plain Zod fallback instead.

### Bun

Applies wherever your code passes through a build step. Requires **Bun ≥ 1.2.22**.

```typescript
import zodCompiler from "zod-compiler/bun";

await Bun.build({ entrypoints: ["./src/index.tsx"], outdir: "./dist", plugins: [zodCompiler()] });
```

For code run straight from source (`bun run src/server.ts`) no build plugin fires — use
[`jit()`](#4-runtime-compilation-no-build-step) to compile in-process, or the
[CLI](#3-cli-no-bundler) to compile ahead of time.

### Schema Hoisting

Schemas built inside functions are rebuilt on every call. With `hoist` (on by default) they move to
module scope:

```typescript
// before                                  // after
function getSchema() {
  const _zh_94b7 = z.object({ name: z.string() });
  return z.object({ name: z.string() });
  function getSchema() {}
  return _zh_94b7;
}
```

Only expressions built from imported bindings and literals move; anything touching locals, `this` or
`new Date()` stays put. Combinator chains on imported schemas qualify via `schemaNamePattern`
(default `/ZodSchema$/`).

In auto mode hoisted schemas also **compile**, rescuing the schema that never leaves a function (a
slonik query, a tRPC input) and so is invisible to export scanning: ~16,700 ns → ~14 ns per call.

### Bundle Size & Cross-File Dedup

Validators share a runtime helper layer imported from one module, so each helper appears once per
bundle. Schemas in a file sharing a structurally identical sub-shape emit its error walk once —
**19-28% raw / 10-18% gzipped**, scaling with how much the file repeats.

Build plugins serve that module from a resolve hook (`virtual:zod-compiler/runtime`, or
`__zod-compiler-runtime__` on webpack and rspack, which reject the `virtual:` scheme). A loader host
has no hook, so [Turbopack](#nextjs-turbopack) imports the same code from the real subpath
`zod-compiler/runtime` instead — opt-in there, since it only pays off where the host bundles that
import rather than leaving it external.

**Transpile-only esbuild builds** (no `--bundle`) never fire the bundler's resolve hooks, so the
`virtual:` specifier would survive into `dist/` and fail at runtime. Set `codegenMode: "inline"` to emit
helpers per file instead:

```typescript
export default [zodCompiler({ schemas: "explicit", codegenMode: "inline" })];
```

Set `output: "bag"` to also drop the retained Zod schema when you don't need `.shape` / `instanceof`.

### Next.js (Turbopack)

Turbopack — the default since Next.js 16 — [runs webpack loaders but no webpack
plugins](https://nextjs.org/docs/app/api-reference/turbopack#webpack-plugins), so use the loader
entry point:

```typescript
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.{ts,tsx}": {
        condition: {
          all: [
            { not: "foreign" }, // skip node_modules
            { content: /[Zz]od/ }, // skip files that cannot contain a schema
          ],
        },
        loaders: ["zod-compiler/turbopack"],
      },
    },
  },
};

export default nextConfig;
```

Automatic mode, unchanged sources, `next dev` and `next build`. Options go in the object form —
`loaders: [{ loader: "zod-compiler/turbopack", options: { verbose: true } }]` — and must be plain
JSON, so `hoist.schemaNamePattern` takes a string, not a RegExp.

Three things worth knowing:

- **Keep the `content` pattern loose.** Narrowing it to `"zod"` skips `zod/v4`, `zod/mini` and the
  `zod-compiler` import behind `schemas: "explicit"` — those files just quietly stay uncompiled.
- **`codegenMode: "lean"` is App-Router-only.** It shares one copy of the helpers across the bundle,
  but Pages Router server code externalizes `node_modules` imports unless
  [`bundlePagesRouterDependencies`](https://nextjs.org/docs/pages/api-reference/config/next-config-js/bundlePagesRouterDependencies)
  is on, so a devDependency install throws `ERR_MODULE_NOT_FOUND` in production.
- **A `"use server"` file can only export async functions**, so keep schemas there inside a function —
  [hoisting](#schema-hoisting) still compiles them. `"use client"` modules need nothing special.

Turbopack caches loader results itself, so cache `.next/cache` in CI rather than
`node_modules/.cache/zod-compiler`. `next dev --webpack` / `next build --webpack` still work, with
`zod-compiler/webpack` in a `webpack()` config as usual.

### SWC

A programmatic `@swc/core` bridge wrapping `transform()`, not a `.swcrc` plugin. Install
`@swc/core`, then:

```typescript
import { transform } from "zod-compiler/swc";

const result = await transform(sourceCode, {
  filename: "src/schemas.ts",
  swc: { jsc: { parser: { syntax: "typescript" } } },
});
```

Defaults `codegenMode` to `"inline"` (SWC has no virtual-module hook); pass
`zodCompiler: { codegenMode: "lean" }` if a later bundler resolves the runtime specifier. Honours
`include`/`exclude` and keeps no disk cache.

### React Native / Expo

There is no Metro plugin — unplugin has no Metro adapter. Use the [CLI](#3-cli-no-bundler); Metro
bundles what it emits as ordinary source:

```bash
npx zod-compiler generate src/schemas/ -o src/schemas/compiled/ --watch
```

Worth the step: **Hermes ships no JIT and no `new Function`**, so Zod's own object fast path is
unavailable on device and [`jit()`](#4-runtime-compilation-no-build-step) cannot run there at all.

Keep schema modules free of `react-native` and `expo-*` imports, transitively — discovery executes
each file and its import graph in Node (in both modes), and one that throws falls back to runtime
Zod silently.

### Compact Output (`output: "compact"`)

Compiles the fast path and delegates the cold error path to the retained Zod schema, dropping
**~73% raw / ~71% gzipped** on 50 distinct schemas. The hot path is unchanged and errors are Zod's own;
only reading `.error` invokes Zod. Mutually exclusive with `output: "bag"`.

```typescript
zodCompiler({ output: "compact" });
```

### Workers and Serverless Startup

Workers often construct every imported schema during module initialization, even when an isolate only
validates a few of them. Compiling all of those schemas can improve validation while increasing bundle
size and startup work. Compact output reduces compiler-generated error-path code, but still retains the
original Zod schema and does not make eager schema construction lazy.

Automatic discovery remains the default. If an application has a clear schema boundary, narrow
`include` or use `schemas: "explicit"` to avoid compiling intermediate exports.

Use `output: "bag"` only when consumers do not need Zod APIs such as `.shape`, `.extend()`, `.meta()`,
or `z.toJSONSchema()`; it can omit the retained schema entirely.

Measure startup separately from validation throughput using the target deployment and bundle.

### Auto Mode: Side Effects Warning

Auto mode executes files to inspect their exports, so a file with schema-shaped exports **and** side
effects runs them at build time. Limit the scan with `include`.

For the common `env.ts` that validates `process.env` and exits, zod-compiler sets
`process.env.ZOD_COMPILER` during discovery and intercepts `process.exit`, so the build never crashes —
those files just fall back to runtime Zod. To keep them compiled, guard on it:

```typescript
if (!process.env.ZOD_COMPILER) {
  // ...validate and exit
}
```

With `@t3-oss/env-*`, pass `skipValidation: !!process.env.ZOD_COMPILER`.

A schema whose SHAPE branches on an env var is baked at build time, and the cache key does not include
the environment — give each environment its own `cache` directory if you share one across them.

### Large projects and CI

Discovery executes each schema file inside the bundler's process, so the **first cold run** is the
expensive one — later runs hit the persistent cache.

```yaml
- uses: actions/cache@v4
  with:
    path: node_modules/.cache/zod-compiler
    key: zod-compiler-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
```

Scope discovery with `include`; set `ZOD_COMPILER_TIMING=1` for a per-phase breakdown. Files that
never mention `zod` cost nothing.

### Parallel Transforms

Discovery runs one file at a time on the bundler's own thread — executions are serialized so
concurrent transforms cannot double-execute a shared dependency. `parallel` moves whole transforms
onto worker threads instead, each with its own loader and module cache, which is what makes running
them at the same time sound.

```typescript
zodCompiler({ parallel: true }); // one worker per core, less one, capped at 4
zodCompiler({ parallel: 2 }); // or pick the count yourself
```

**Whether it pays depends on your import graph, not your core count.** A module shared by many
schema files is executed once in-process and once _per worker_ here. Files with independent graphs
win; files chained through each other can lose. Both rows below are 120 files of 8 schemas each, on
12 performance cores — the only difference is whether the files import one another:

| Transform (120 files) | in-process |      n=2 |      n=4 |      n=8 |     n=12 |
| --------------------- | ---------: | -------: | -------: | -------: | -------: |
| independent graphs    |   3,633 ms | 2,263 ms | 1,508 ms | 1,786 ms | 2,119 ms |
| 120-deep import chain |     945 ms |   977 ms | 1,045 ms | 1,796 ms | 3,332 ms |

So measure before adopting it — `ZOD_COMPILER_TIMING=1` prints the per-phase breakdown, and the
`discover` line is the one workers move. Throughput peaks around four workers and declines past it:
beyond that point every extra worker re-executes more graph, holds another copy of it in memory, and
adds to the generated source that the single receiving thread has to deserialize.

Emitted code, sourcemaps and cache entries are identical either way — `parallel` is not part of the
cache key, so a parallel build and a serial one share the same cache. The disk cache and dependency
crawling stay on the bundler thread, and if a worker cannot start or dies mid-build its file is
retried in-process rather than failing the build.

A **warm cache still beats parallelism**, and costs no memory — reach for `parallel` for the cold
runs the cache cannot help with.

## Framework Examples

Nothing framework-specific is needed — exported schemas are compiled in place, so anything accepting
a Zod schema picks up the compiled version:

```typescript
// tRPC — no .input(compile(...)) needed
t.procedure.input(CreateUserSchema).mutation(({ input }) => createUser(input));

// Hono
app.post("/users", zValidator("json", UserSchema), (c) => c.json(c.req.valid("json")));

// React Hook Form
useForm({ resolver: zodResolver(SignupSchema) });
```

The same applies to any [Standard Schema](https://standardschema.dev) consumer — `~standard.validate`
routes through the compiled validator.

Compiled methods live on the schema object, so Zod's functional API (`z.safeParse(Schema, x)`) and a
compiled schema composed into an uncompiled parent stay on plain Zod.

## Schema Diagnostics

Check coverage and Fast Path eligibility before compiling:

```bash
npx zod-compiler check src/schemas.ts
```

Output:

```
src/schemas.ts

  CreateUserSchema — 100% compiled (4/4 nodes) | Fast Path: eligible
    └─ ✓ object
       ├─ ✓ string .name
       ├─ ✓ string .email
       ├─ ✓ number .age
       └─ ✓ enum .role

  OrderSchema — 67% compiled (2/3 nodes) | Fast Path: ineligible (fallback (transform))
    └─ ✓ object
       ├─ ✓ string .id
       └─ ✓ object .metadata
          ├─ ✓ string .metadata.region
          └─ ✗ fallback .metadata.audit (transform)
                hint: Extract transform into a separate post-processing step

    Fallbacks:
      ✗ .metadata.audit — transform
        Extract transform into a separate post-processing step
```

### CI Integration

```bash
# JSON output
npx zod-compiler check src/schemas.ts --json

# Fail if any schema below 80% coverage
npx zod-compiler check src/schemas.ts --json --fail-under 80
```

| Flag                 | Description                             |
| -------------------- | --------------------------------------- |
| `--json`             | Structured JSON output                  |
| `--fail-under <pct>` | Exit code 1 if coverage below threshold |
| `--no-color`         | Disable colored output                  |

## What Gets Compiled

### Fully Compiled (1.1-46x faster)

Every Zod type except the fallbacks below — all primitives, `object` / `strictObject` / `looseObject`,
`array`, `tuple`, `record`, `set`, `map`, `union`, `discriminatedUnion`, `intersection`, `pipe`,
the `optional` / `nullable` / `readonly` / `default` / `catch` / `coerce` wrappers, `templateLiteral`,
recursive `lazy` (self, mutual and nested), `custom` / `instanceof`, and
`transform` / `refine` / `superRefine`.

All standard checks are supported: `min`, `max`, `length`, `email`, `uuid`, `regex`, `int`, `positive`,
`multipleOf`, `includes`, `startsWith`, and the rest.

### Falls Back to Zod (Still Works, Not Faster)

A schema delegates to Zod when it reaches JavaScript the generated code cannot reproduce:

| Construct                                            | Why                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `.check(fn)`, `superRefine` + later checks           | The callback holds Zod's payload unmediated, or `fatal` aborts Zod's chain |
| `ctx`-taking or `async` callbacks                    | Needs Zod's parse context / the async pipeline                             |
| `z.url()`, `z.jwt()`                                 | Algorithmic formats (`new URL()`, signature parsing)                       |
| Overlapping or policy-sensitive object intersections | Zod's independent parse-and-merge semantics cannot be safely collapsed     |
| `.readonly()` over a pass-through container          | Zod freezes the output it rebuilt; these are the caller's own input        |
| Dynamic error maps, unresolvable `z.lazy()`          | Not knowable at build time                                                 |

Everything else compiles, including context-free `preprocess` callbacks and
`transform`/`refine`/`superRefine` whether or not the callback captures — a zero-capture one is inlined,
a capturing one called by reference. Delegation is per-sub-schema: one uncompilable field goes to Zod,
not the whole object. Run `zod-compiler check` to see what compiled.

### Behavioral Differences from Zod

Compiled validators match Zod on verdicts, output data and error messages, including issue ordering.
Three things differ by design:

| Behavior                  | Zod                                             | zod-compiler                                            |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| Record key iteration      | Own enumerable keys, symbols included           | Own enumerable **string** keys only                     |
| Container output identity | A fresh array / set / map / object              | The input container, by reference (array holes survive) |
| Per-call parse params     | `safeParse(x, { error, reportInput })` honoured | Ignored; global `z.config()` maps still apply           |

Schema-level `error` and `z.config()` maps are unaffected; for a per-call map use
`z.safeParse(Schema, x, params)`.

`z.object()` strips unknown keys exactly as Zod does, so its output is always a fresh object.

## Benchmark

5-way comparison: **Zod v3** vs **Zod v4** vs **zod-compiler** vs **[Typia](https://typia.io/)** vs **[AJV](https://ajv.js.org/)**

| Scenario                                        | Zod v3 | Zod v4 | **zod-compiler** | Typia | AJV   | vs Zod v4 |
| ----------------------------------------------- | ------ | ------ | ---------------- | ----- | ----- | --------- |
| simple string                                   | 8.5M   | 10.4M  | **11.0M**        | 11.1M | 11.2M | 1.1x      |
| string (min/max)                                | 8.2M   | 4.9M   | **10.8M**        | 11.0M | 10.0M | 2.2x      |
| number (int+positive)                           | 7.9M   | 6.7M   | **10.7M**        | 11.1M | 11.4M | 1.6x      |
| enum                                            | 8.0M   | 9.4M   | **11.1M**        | 11.2M | 11.3M | 1.2x      |
| bigint (min/max)                                | 7.6M   | 5.6M   | **10.9M**        | —     | —     | 2.0x      |
| tuple [string, int, bool]                       | 3.9M   | 4.8M   | **10.9M**        | 10.6M | 10.1M | 2.3x      |
| record\<string, number\>                        | 2.2M   | 1.8M   | **8.0M**         | 7.3M  | 9.6M  | 4.6x      |
| set\<string\> (5 items)                         | 2.5M   | 1.5M   | **9.9M**         | —     | —     | 6.8x      |
| set\<string\> (20 items)                        | 918K   | 445K   | **7.7M**         | —     | —     | **17x**   |
| map\<string, number\> (5 entries)               | 1.4M   | 864K   | **8.7M**         | —     | —     | **10x**   |
| map\<string, number\> (20 entries)              | 448K   | 236K   | **5.5M**         | —     | —     | **24x**   |
| pipe (non-transform)                            | 5.9M   | 3.2M   | **10.5M**        | —     | —     | 3.3x      |
| discriminatedUnion (3 variants)                 | 2.3M   | 3.6M   | **10.7M**        | 10.3M | 5.4M  | 3.0x      |
| discriminatedUnion (8 variants, rotating)       | 1.8M   | 3.1M   | **6.6M**         | —     | —     | 2.1x      |
| plain union of 8 tagged objects (auto-discrim.) | 244K   | 898K   | **6.1M**         | —     | —     | 6.8x      |
| strict object (DB row)                          | 1.2M   | 2.0M   | **7.0M**         | —     | —     | 3.6x      |
| medium object (valid)                           | 1.3M   | 1.5M   | **5.6M**         | 6.9M  | 4.7M  | 3.9x      |
| medium object (extra keys stripped)             | 1.2M   | 1.3M   | **5.7M**         | —     | —     | 4.3x      |
| medium object (invalid)                         | 359K   | 263K   | **9.8M**         | 2.0M  | 5.1M  | **37x**   |
| large object (10 items)                         | 82K    | 110K   | **3.6M**         | 3.8M  | 765K  | **33x**   |
| large object (100 items)                        | 9K     | 12K    | **531K**         | 759K  | 82K   | **46x**   |
| readonly field (wrapper compiles away)          | 2.2M   | 4.7M   | **11.0M**        | —     | —     | 2.3x      |
| readonly root object (rebuild + freeze)         | 2.1M   | 4.0M   | **8.6M**         | —     | —     | 2.1x      |
| readonly array (delegates to Zod)               | 2.8M   | 3.0M   | **2.9M**         | —     | —     | 1.0x      |
| recursive tree (7 nodes)                        | 407K   | 727K   | **5.3M**         | 7.4M  | 2.9M  | 7.3x      |
| recursive tree (121 nodes)                      | 23K    | 42K    | **510K**         | 1.3M  | 232K  | **12x**   |
| nested recursion (7 nodes)                      | 280K   | 489K   | **4.6M**         | 7.2M  | 1.8M  | 9.3x      |
| nested recursion (121 nodes)                    | 17K    | 30K    | **461K**         | 1.1M  | 126K  | **15x**   |
| deeply nested object (243 leaves)               | 8K     | 20K    | **327K**         | 666K  | 83K   | **17x**   |
| event log (combined)                            | 257K   | 575K   | **4.9M**         | —     | —     | 8.6x      |
| object with transform (zero-capture)            | 752K   | 1.3M   | **4.4M**         | —     | —     | 3.4x      |
| array 10 × transform (zero-capture)             | 89K    | 137K   | **2.7M**         | —     | —     | **20x**   |
| array 50 × transform (zero-capture)             | 18K    | 28K    | **689K**         | —     | —     | **25x**   |
| object with captured transform                  | 862K   | 5.4M   | **9.6M**         | —     | —     | 1.8x      |
| object with captured refine (cross-field)       | 995K   | 1.3M   | **7.3M**         | —     | —     | 5.6x      |
| object with superRefine (cross-field)           | 1.0M   | 1.4M   | **5.9M**         | —     | —     | 4.3x      |
| coerced query object (valid)                    | 1.2M   | 2.0M   | **3.6M**         | —     | —     | 1.8x      |
| coerced query object (invalid)                  | 754K   | 603K   | **6.8M**         | —     | —     | **11x**   |
| preprocessed query object (valid)               | 302K   | 1.1M   | **3.6M**         | —     | —     | 3.2x      |
| preprocessed query object (invalid)             | 268K   | 574K   | **7.8M**         | —     | —     | **14x**   |
| stringbool config object (valid)                | —      | 2.0M   | **3.7M**         | —     | —     | 1.9x      |
| stringbool config object (invalid)              | —      | 497K   | **8.6M**         | —     | —     | **17x**   |
| custom/instanceof request (valid)               | 689K   | 2.0M   | **5.6M**         | —     | —     | 2.7x      |
| custom/instanceof request (invalid)             | 527K   | 624K   | **5.7M**         | —     | —     | 9.1x      |
| disjoint object intersection (valid)            | 946K   | 1.0M   | **5.7M**         | —     | —     | 5.5x      |
| disjoint object intersection (invalid)          | 343K   | 240K   | **9.8M**         | —     | —     | **41x**   |

_ops/s, higher is better. `vp test bench` on an Apple M1 Max (zod 4.5.2, zod v3 3.23.8, typia 12, ajv 8),
best of three runs. The harness costs ~90 ns per iteration, so the fastest rows sit at that floor and gaps
between the AOT columns there are noise, not real._

Nested objects, arrays and recursive types gain the most. Rejection is fast because a failed
`safeParse` defers building the error until `.error` is read. Zod 4.5 stopped capturing a stack trace on
that path too, so its own rejected-input rows are several times faster than 4.3's and the gap there is
narrower than it was.

```bash
vp run benchmark # run locally
```

### Performance Architecture

An eligible schema compiles to a **fast path** — one `&&` chain validating the whole input with zero
allocations, reused by `.is()` and `parse()` — plus a **slow path** that collects errors, run only on
failure and deferred until `.error` is read. A `z.object()` strips, so it instead compiles to a single
pass that validates and rebuilds together, bailing on the first failure — including the reshaping
idioms (array size checks, `.refine()`, `.default()`, `.trim()`, `.transform()`).

Regexes are pre-compiled with bounded repeats unrolled, checks run cheapest-first, discriminated unions
dispatch through a jump table (plain tagged unions are auto-discriminated into it), and oversized check
functions are split to stay within V8's optimizer budget. Stripping objects, native coercions,
`stringbool`, defaults, string rewrites, context-free preprocessors and synchronous transforms validate
and build their output in one pass. An intersection of two objects with disjoint keys compiles to that
same single pass over the merged shape, and `z.custom()` / `z.instanceof()` compile to a direct predicate
call.

Where success is cheaper to compile than failure, only the verdict and output are compiled: intersections
and `custom` keep the original Zod schema to construct issues, so a rejection still reports exactly what
Zod would — including an intersection's one-issue-per-side shape — without slowing the hot path.

## Development

```bash
vp install
vp test
vp run benchmark
vp run lint
```

## Acknowledgements

zod-compiler started as a fork of [zod-aot](https://github.com/wakita181009/zod-aot) by [@wakita181009](https://github.com/wakita181009).
