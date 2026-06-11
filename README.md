# zod-compiler

**Compile Zod schemas into zero-overhead validation functions at build time.**

Keep your existing Zod schemas. Get **2-74x faster** validation. No code changes required.

```typescript
// vite.config.ts — add one line
import zodCompiler from "zod-compiler/vite";

export default defineConfig({
  plugins: [zodCompiler()],
});
```

```typescript
// src/schemas.ts — write plain Zod, nothing else
import { z } from "zod";

export const UserSchema = z.object({
  name: z.string().min(3),
  email: z.email(),
  age: z.number().int().positive(),
});

// Use it anywhere — tRPC, Hono, React Hook Form, etc.
// At build time, zod-compiler compiles it to a 2-74x faster validator.
```

## Install

```bash
npm install zod-compiler zod@^4
```

| Runtime | Version |
| ------- | ------- |
| Node.js | 20+     |
| Bun     | 1.3+    |
| Deno    | 2.0+    |

## Usage

There are three ways to use zod-compiler. Choose the one that fits your project.

### 1. Automatic Mode (Default)

The plugin automatically detects and compiles all exported Zod schemas at build time. No wrappers, no imports from `zod-compiler` in your source code.

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
  age: z.number().int().min(0).max(150),
  role: z.enum(["admin", "editor", "viewer"]),
});

export const UpdateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.email().optional(),
});

export const ListUsersSchema = z.object({
  page: z.number().int().min(1).optional().default(1),
  limit: z.number().int().min(1).max(100).optional().default(20),
});
```

**Use them as usual:**

```typescript
const user = CreateUserSchema.parse(data); // throws on failure
const result = CreateUserSchema.safeParse(data); // { success, data/error }
```

At build time, the plugin:

1. Finds every file with `import ... from "zod"` (skips type-only imports)
2. Statically pre-filters: files whose exports provably can't be schemas (functions, components, constants) are skipped without ever being executed
3. Executes the remaining candidates and detects exported Zod schemas
4. Compiles each schema into an optimized validator
5. Replaces the export with a tree-shakeable IIFE that preserves the full Zod API

**What "preserves the full Zod API" means:** The optimized `parse`/`safeParse`/`parseAsync`/`safeParseAsync` methods are installed directly on the original schema object, which is exported as-is. Identity is preserved, so `._zod`, `.shape`, Standard Schema (`~standard`), `instanceof`, `.meta()` / `z.globalRegistry`, and `z.toJSONSchema()` all still work. Libraries that accept Zod schemas (tRPC, Hono, React Hook Form) work without changes.

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

`compile()` and auto mode coexist — `compile()` schemas are detected first, then every remaining plain Zod export is picked up. To make `compile()` the _only_ path (no automatic detection, no build-time execution of plain schema files), pair it with `schemas: "explicit"` in the plugin options.

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
```

## Build Plugin

### Supported Build Tools

| Build Tool | Import                                            |
| ---------- | ------------------------------------------------- |
| Vite       | `import zodCompiler from "zod-compiler/vite"`     |
| webpack    | `import zodCompiler from "zod-compiler/webpack"`  |
| esbuild    | `import zodCompiler from "zod-compiler/esbuild"`  |
| Rollup     | `import zodCompiler from "zod-compiler/rollup"`   |
| Rolldown   | `import zodCompiler from "zod-compiler/rolldown"` |
| rspack     | `import zodCompiler from "zod-compiler/rspack"`   |
| Bun        | `import zodCompiler from "zod-compiler/bun"`      |
| Farm       | `import zodCompiler from "zod-compiler/farm"`     |

### Options

| Option    | Type                          | Default         | Description                                                                                                                                                                                                                            |
| --------- | ----------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas` | `"auto" \| "explicit"`        | `"auto"`        | How schemas are found. `"auto"`: every exported Zod schema compiles (also enables compiling hoisted in-function schemas). `"explicit"`: only `compile()`-wrapped schemas; only files importing zod-compiler execute at build time      |
| `include` | `string[]`                    | —               | Only process files matching these path globs (picomatch, matched anywhere in the path; plain substrings work too)                                                                                                                      |
| `exclude` | `string[]`                    | —               | Skip files matching these path globs (same matching rules as `include`)                                                                                                                                                                |
| `output`  | `"schema" \| "bag"`           | `"schema"`      | What a compiled export evaluates to. `"schema"`: the original Zod schema with compiled methods installed (full API preserved). `"bag"`: a minimal methods-only object — smaller bundles, breaks Zod-schema consumers                   |
| `verbose` | `boolean`                     | `false`         | Log per-schema compilation status during build                                                                                                                                                                                         |
| `hoist`   | `boolean`                     | `true`          | Hoist Zod schemas defined inside function bodies to module scope so they're constructed once instead of per call (babel-plugin-zod-hoist equivalent). Only expressions built purely from imports and literals are hoisted              |
| `apply`   | `"build" \| "serve" \| "all"` | builds + Vitest | **Vite only**: when the plugin runs. By default, production builds and test runs are compiled (so tests exercise what ships); plain dev servers use the Zod fallback. `"all"` also compiles the dev server; `"build"` also skips tests |
| `cache`   | `boolean \| string`           | `true`          | Persistent transform cache (`node_modules/.cache/zod-compiler`, or a custom directory). Skips discovery + codegen across processes when nothing changed; entries self-validate against dependency content hashes                       |

> `autoDiscover: boolean` and `zodCompat: boolean` still work as deprecated aliases
> (`autoDiscover: true` → `schemas: "auto"`, `zodCompat: false` → `output: "bag"`);
> the new options win when both are present.

```typescript
zodCompiler({
  include: ["src/schemas"],
  verbose: true,
});
```

> **Note:** Vitest is detected automatically (via the `VITEST` env var), so
> tests compile and exercise the same validators that ship to production —
> including their performance. Pass `apply: "build"` if you want tests to use
> the plain Zod fallback instead.

### Schema Hoisting

Schemas defined inside functions are rebuilt on every call — a hidden cost in
React components, request handlers, and helpers. With `hoist` (on by default),
the plugin moves them to module scope:

```typescript
// before
function getSchema() {
  return z.object({ name: z.string() }); // rebuilt per call
}

// after (build output)
const _zh_94b7f5c1 = z.object({ name: z.string() });
function getSchema() {
  return _zh_94b7f5c1; // built once per module
}
```

Hoisting is conservative: only expressions built purely from **imported
bindings and literals** move. Anything referencing local variables,
module-level bindings, `this`, or eagerly-evaluated globals (`new Date()`,
`Math.random()`) stays where it is — though safe globals inside callbacks
(`refine((v) => Number.isFinite(v))`) are fine, since callbacks run per parse
regardless. Inline `.parse(...)` calls are peeled so evaluation stays at the
call site (`z.string().parse(x)` → `_zh_….parse(x)`), names that are ever
shadowed (`function f(z) {...}`) disqualify hoists referencing them, and
identical schemas dedupe to a single binding.

Combinator chains on imported schemas also qualify: bases matching
`schemaNamePattern` (default `/ZodSchema$/`) or chains containing an inline
`z.*` reference (`Base.extend({ a: z.string() })`). Configure via
`hoist: { schemaNamePattern: /Shape$/ }` (string and `null` accepted).

#### Hoisted schemas compile too (auto mode)

The most common shape this rescues is a schema that never leaves a function —
a [slonik](https://github.com/gajus/slonik) query, a tRPC input, a handler-local
validator. It is not exported, so export scanning alone would never see it:

```typescript
import { pool, sql } from "./db.js";
import { z } from "zod";

const getUser = (id: number) => {
  return pool.one(
    sql.type(
      z.object({
        id: z.number(),
        name: z.string(),
      }),
    )`SELECT id, name FROM users WHERE id = ${id}`,
  );
};
```

In auto mode (the default), the build output is (verbatim, lightly trimmed):

```typescript
import { __zcFin, __zcFinD, __zcIT, __zcMkv } from "virtual:zod-compiler/runtime";
const _zh_6c9cb1a3 = /* @__PURE__ */ (() => {
  function __fc_0(input) {
    return (
      typeof input === "object" &&
      input !== null &&
      !Array.isArray(input) &&
      Number.isFinite(input["id"]) &&
      typeof input["name"] === "string"
    );
  }
  function __sw_2(input) {
    var _e = [];
    /* error-collecting walk — runs only when .error is read */ return _e;
  }
  function safeParse__zh_6c9cb1a3(input) {
    if (__fc_0(input)) {
      return { success: true, data: input };
    }
    return __zcFinD(__sw_2, input);
  }
  return __zcMkv(
    safeParse__zh_6c9cb1a3,
    z.object({
      id: z.number(),
      name: z.string(),
    }),
    __fc_0,
  );
})();
import { pool, sql } from "./db.js";
import { z } from "zod";

const getUser = (id: number) => {
  return pool.one(sql.type(_zh_6c9cb1a3)`SELECT id, name FROM users WHERE id = ${id}`);
};
```

Reading it bottom-up:

- **The real Zod schema is still constructed** (once, at module load) and is the
  object `_zh_6c9cb1a3` resolves to — `__zcMkv` installs the compiled
  `parse`/`safeParse`/`parseAsync`/`safeParseAsync` as own properties on it and
  returns it. `sql.type()` receives a genuine Zod schema (identity, `.shape`,
  `._zod`, Standard Schema all intact) whose `safeParse` happens to be compiled.
- **`__fc_0` is the Fast Path**: when slonik validates each row, a valid row
  costs one boolean chain — no per-node traversal, no allocations beyond the
  result object.
- **`__sw_2` + `__zcFinD` are the failure path**: an invalid row returns
  `{success: false}` immediately; the full error walk runs lazily only if
  `.error` is actually read.
- The `sql.type(...)` call itself stays at the call site (it closes over `id`
  via the tagged template) — only its schema argument was hoisted and compiled.

Measured on this exact pattern: schema construction + validation drops from
~16,700ns to ~14ns per call — construction amortizes to module load, and
per-row validation rides the Fast Path. With `schemas: "explicit"` the same file
still gets the plain hoist (construction once instead of per call); the
compiled IIFE requires auto mode (the default) because the schema is anonymous.

### Bundle Size & Cross-File Dedup

Generated validators share a small runtime helper layer (`__zcMkv` validator
wrapper, issue factories like `__zcTS`/`__zcIT`, and well-known regexes for
`email`, `uuid`, `cuid`, `ipv4`, etc.).

On every supported bundler the plugin imports these helpers from a single
plugin-provided runtime module — `virtual:zod-compiler/runtime` on Vite,
Rollup, Rolldown, esbuild, Farm, and Bun, or the bare-specifier alias
`__zod-compiler-runtime__` on webpack and rspack (which reject the `virtual:`
URI scheme) — so the bundler emits a single bundle-wide copy regardless of how
many files reference them.

The result: a 5-file project with 10 schemas all using `z.email()` and
`z.uuid()` produces a bundle where each shared regex appears exactly **once**.
Set `output: "bag"` to additionally drop the original Zod schema reference
when you don't need `instanceof` / `.shape` access on the compiled output.

### Auto Mode: Side Effects Warning

In auto mode (the default), the plugin executes files to inspect their exports. A static pre-filter skips files whose exports provably can't be schemas without executing them — but if a file has schema-shaped exports AND side effects (starts a server, connects to a database), those side effects run at build time.

**Fix:** Use `include` to limit which files are scanned:

```typescript
zodCompiler({
  include: ["src/schemas", "src/validators"],
});
```

### schemas: "auto" vs "explicit"

|                              | `"auto"` (default)                                         | `"explicit"` + compile()                    |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| Source code changes          | None                                                       | Wrap each schema                            |
| `zod-compiler` import needed | No                                                         | Yes                                         |
| What gets compiled           | All exported Zod schemas                                   | Only wrapped schemas                        |
| Build-time file execution    | Zod-importing files that may export schemas (pre-filtered) | Files with `import ... from "zod-compiler"` |
| Best for                     | New projects, framework integration                        | Gradual adoption, selective optimization    |

### Large projects and CI

Discovery executes each schema file — and transitively its first-party import
graph — inside the bundler's single-threaded process. In a repository where
schema files pull in thousands of modules, the **first cold run** is the
expensive part: subsequent runs hit the persistent cache and skip discovery
entirely. On saturated CI hosts a cold discovery of a huge graph can stall the
bundler's event loop long enough to trip test timeouts (the plugin warns when
a single file's discovery exceeds 5s). Three levers, in order of impact:

**1. Persist the cache across CI runs.** The cache directory is small
(dependency snapshots are content-addressed and shared between entries) and
entries self-validate against dependency content hashes — restoring a stale
cache can only cause recompiles, never stale output:

```yaml
# GitHub Actions
- uses: actions/cache@v4
  with:
    path: node_modules/.cache/zod-compiler
    key: zod-compiler-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
    restore-keys: zod-compiler-${{ runner.os }}-
```

**2. Scope what gets discovered.** `include` limits discovery to your schema
directories. If test startup latency matters more than test-time validator
performance, run hoist-only in Vitest and compile only real builds:

```typescript
// vitest.config.ts — hoisting still applies; validation uses plain Zod
zodCompiler({ schemas: "explicit" });

// vite.config.ts (build)
zodCompiler({ include: ["src/schemas"] });
```

**3. Measure before tuning.** `ZOD_COMPILER_TIMING=1` prints per-phase wall
time (hoist / static-filter / discover / compile) on exit, so you can see
whether discovery or codegen dominates and which files pay it.

## Framework Examples

### tRPC

```typescript
// src/schemas.ts
import { z } from "zod";

export const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.email(),
  age: z.number().int().min(0).max(150),
});

// src/router.ts
import { CreateUserSchema } from "./schemas";

export const appRouter = t.router({
  createUser: t.procedure.input(CreateUserSchema).mutation(({ input }) => createUser(input)),
});
```

In auto mode (the default), `CreateUserSchema` is compiled at build time. The tRPC router uses the optimized version automatically. No `.input(compile(CreateUserSchema))` needed.

### Hono

```typescript
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { UserSchema } from "./schemas";

const app = new Hono();

app.post("/users", zValidator("json", UserSchema), (c) => {
  const user = c.req.valid("json");
  return c.json(user);
});
```

### React Hook Form

```typescript
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { UserSchema } from "./schemas";

function UserForm() {
  const form = useForm({
    resolver: zodResolver(UserSchema),
  });
  // ...
}
```

### Any Standard Schema Consumer

Compiled schemas are the original Zod schema objects with optimized parse methods installed, so they still implement [Standard Schema](https://standardschema.dev). Any library that accepts Standard Schema validators works automatically.

## Schema Diagnostics

Analyze your schemas before compiling — check coverage, Fast Path eligibility, and get actionable hints:

```bash
npx zod-compiler check src/schemas.ts
```

Output:

```
src/schemas.ts

  CreateUserSchema  [Fast Path]  100% compiled  (5 checks)
  ├─ name: string (min_length, max_length)
  ├─ email: string (string_format[email])
  ├─ age: number (number_format[safeint], greater_than)
  └─ role: enum

  OrderSchema  [Slow Path]  85% compiled  (3 checks)
  ├─ id: string (string_format[uuid])
  └─ metadata: object
      └─ audit: fallback(transform)
         Hint: Consider z.pipe() to keep inner schema compilable

  Summary: 2 schemas | 1 Fast Path, 1 Slow Path | 8/9 nodes (88.9%)
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

### Fully Compiled (2-74x faster)

`string`, `number`, `bigint`, `boolean`, `null`, `undefined`, `any`, `unknown`, `literal`, `enum`, `stringbool`, `date`, `file`, `object`, `strictObject` / `.strict()`, `looseObject`, `array`, `tuple`, `record`, `set`, `map`, `union`, `discriminatedUnion`, `intersection`, `pipe` (non-transform), `optional`, `nullable`, `readonly`, `default`, `catch`, `coerce`, `templateLiteral`, `symbol`, `void`, `nan`, `never`, `lazy` (self-recursive), `transform` / `refine` (zero-capture — see below)

All standard Zod checks are supported: `min`, `max`, `length`, `email`, `url`, `uuid`, `regex`, `int`, `positive`, `negative`, `multipleOf`, `int32`, `uint32`, `float32`, `float64`, `includes`, `startsWith`, `endsWith`, and more.

### Falls Back to Zod (Still Works, Not Faster)

These contain JavaScript callbacks that cannot be reproduced in generated code:

| Type                                 | Why                                                           | Alternative                                   |
| ------------------------------------ | ------------------------------------------------------------- | --------------------------------------------- |
| `transform` / `refine` with captures | Callback captures outer variables (or is async / takes `ctx`) | Use zero-capture callbacks or built-in checks |
| `superRefine`                        | Callback needs `ctx` for issue collection                     | Use `refine` or built-in checks               |
| `custom`                             | Arbitrary validation logic                                    | —                                             |
| `preprocess`                         | Input preprocessing function                                  | Use `z.coerce` when possible                  |
| `lazy` (non-recursive)               | Cannot resolve inner type                                     | Use self-referencing lazy for recursion       |
| `.catchall(schema)`                  | Unknown keys validated against a value schema                 | `strictObject` and `looseObject` both compile |

**Zero-capture effects compile:** a `transform`/`refine` callback that takes a
single argument and references only its own parameters, locals, and safe
globals (`Math`, `Number`, `JSON`, …) is extracted via `fn.toString()` and
inlined into the generated validator. `z.string().transform((s) => s.trim())`
compiles; `z.string().transform((s) => s + suffix)` falls back (it captures
`suffix`).

**Partial fallback:** If an object has 10 properties and 1 uses `transform`, the other 9 are still compiled. Only the `transform` property falls back to Zod.

**Tip:** Run `npx zod-compiler check` to see exactly which parts of your schemas are compiled and which fall back.

## Benchmarks

5-way comparison: **Zod v3** vs **Zod v4** vs **zod-compiler** vs **[Typia](https://typia.io/)** vs **[AJV](https://ajv.js.org/)**

| Scenario                                          | Zod v3 | Zod v4 | **zod-compiler** | Typia | AJV   | vs Zod v4 |
| ------------------------------------------------- | ------ | ------ | ---------------- | ----- | ----- | --------- |
| simple string                                     | 12.9M  | 14.4M  | **16.6M**        | 17.0M | 17.5M | 1.2x      |
| string (min/max)                                  | 12.0M  | 7.4M   | **16.2M**        | 17.0M | 14.5M | 2.2x      |
| number (int+positive)                             | 11.7M  | 7.8M   | **16.4M**        | 16.9M | 17.0M | 2.1x      |
| enum                                              | 11.5M  | 11.9M  | **15.3M**        | 15.1M | 16.0M | 1.3x      |
| bigint (min/max)                                  | 11.7M  | 7.7M   | **16.1M**        | —     | —     | 2.1x      |
| tuple [string, int, bool]                         | 5.9M   | 5.1M   | **16.9M**        | 17.8M | 16.6M | 3.3x      |
| record\<string, number\>                          | 3.2M   | 2.8M   | **10.8M**        | 12.1M | 15.7M | 3.9x      |
| set\<string\> (5 items)                           | 3.7M   | 2.2M   | **14.4M**        | —     | —     | 6.7x      |
| set\<string\> (20 items)                          | 1.1M   | 667K   | **11.1M**        | —     | —     | **17x**   |
| map\<string, number\> (5 entries)                 | 1.8M   | 1.2M   | **10.4M**        | —     | —     | 8.7x      |
| map\<string, number\> (20 entries)                | 582K   | 315K   | **8.1M**         | —     | —     | **26x**   |
| pipe (non-transform)                              | 8.8M   | 5.8M   | **16.6M**        | —     | —     | 2.9x      |
| discriminatedUnion (3 variants)                   | 3.1M   | 3.9M   | **15.1M**        | 14.9M | 7.3M  | 3.9x      |
| strict object (DB row)                            | 1.8M   | 3.2M   | **7.2M**         | —     | —     | 2.3x      |
| medium object (valid)                             | 1.9M   | 2.4M   | **9.7M**         | 10.5M | 7.4M  | 4.0x      |
| medium object (invalid)                           | 518K   | 76K    | **5.6M**         | 2.9M  | 7.7M  | **74x**   |
| large object (10 items)                           | 117K   | 166K   | **7.6M**         | 5.8M  | 1.0M  | **46x**   |
| large object (100 items)                          | 13K    | 18K    | **1.3M**         | 1.2M  | 110K  | **72x**   |
| recursive tree (7 nodes)                          | 572K   | 2.1M   | **12.9M**        | 12.1M | 4.7M  | 6.2x      |
| recursive tree (121 nodes)                        | 31K    | 140K   | **1.9M**         | 1.9M  | 353K  | **14x**   |
| event log (combined)                              | 364K   | 536K   | **5.9M**         | —     | —     | **11x**   |
| object with transform (zero-capture)              | 1.0M   | 1.8M   | **5.7M**         | —     | —     | 3.2x      |
| array 10 × transform (zero-capture)               | 104K   | 188K   | **2.9M**         | —     | —     | **15x**   |
| array 50 × transform (zero-capture)               | 24K    | 43K    | **737K**         | —     | —     | **17x**   |
| object with captured transform (partial fallback) | 1.4M   | 6.1M   | **6.5M**         | —     | —     | 1.1x      |

_ops/s, higher is better. "—" = not supported by the library. Measured with `vitest bench` on Apple M-series (zod 4.3.6, zod v3 3.23.8, typia 12, ajv 8)._

Performance scales with schema complexity. Nested objects and arrays see the biggest gains because zod-compiler eliminates per-node traversal overhead. `discriminatedUnion` uses O(1) `switch` dispatch instead of Zod's sequential trial. The invalid-input row is large because failed `safeParse` defers error materialization until `.error` is read. Zero-capture `transform`/`refine` callbacks are compiled (3-17x); schemas with captured callbacks fall back per-field and roughly match Zod.

`parse()` (throwing API) rides a zero-allocation fast path: medium object 2.2M → 9.1M ops/s (4.2x), large object (100 items) 18K → 1.4M ops/s (76x).

```bash
pnpm benchmark   # run locally
```

### Performance Architecture

For eligible schemas, zod-compiler generates a **two-phase validator**:

1. **Fast Path** — A single `&&` expression chain that validates the entire input with zero allocations. Valid input returns immediately.
2. **Slow Path** — Error-collecting validation that only runs when the Fast Path fails.

Additional optimizations: check ordering (cheap checks first), pre-compiled regex, Set-based enum lookups, small enum inlining (`===` for up to 5 values).

Run `npx zod-compiler check --json` to see which schemas qualify for Fast Path.

## Development

```bash
pnpm install
pnpm test
pnpm benchmark
pnpm lint
```

## Acknowledgements

zod-compiler started as a fork of [zod-aot](https://github.com/wakita181009/zod-aot) by [@wakita181009](https://github.com/wakita181009).
