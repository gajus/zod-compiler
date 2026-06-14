# zod-compiler

**Compile Zod schemas into zero-overhead validation functions at build time.**

Keep your existing Zod schemas. Get **2-75x faster** validation. No code changes required.

- [What Gets Compiled](#what-gets-compiled)
- [Schema Hoisting](#schema-hoisting)
- [Benchmark](#benchmark)

> [!NOTE]
> zod-compiler has been tested to work in large projects with tens of thousands of Zod schemas.

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

**Zero-allocation type guard — `.is()`:** compiled schemas also expose an `.is(input): input is T` boolean guard. For the common case (objects, primitives, arrays, enums with no `coerce`/`default`/`catch`/`transform`) this _is_ the compiled fast-check — one boolean expression, no `SafeParseResult`, no issues array — the cheapest possible "does this match?" check, on par with typia's `is<T>()` and a clean replacement for `schema.safeParse(x).success`:

```typescript
if (CreateUserSchema.is(data)) {
  data.email; // narrowed to the schema's output type
}
const valid = items.filter((x) => CreateUserSchema.is(x));
```

Schemas without a total fast path fall back to `safeParse(input).success` (still correct). The guard is also available on `compile()`-wrapped schemas (Zod's runtime fallback before the build).

At build time, the plugin:

1. Finds every file with `import ... from "zod"` (skips type-only imports)
2. Statically pre-filters: files whose exports provably can't be schemas (functions, components, constants) are skipped without ever being executed
3. Executes the remaining candidates and detects exported Zod schemas
4. Compiles each schema into an optimized validator
5. Replaces the export with a tree-shakeable IIFE that preserves the full Zod API

**What "preserves the full Zod API" means:** The optimized `parse`/`safeParse`/`parseAsync`/`safeParseAsync` methods (plus the `.is()` guard) are installed directly on the original schema object, which is exported as-is. Identity is preserved, so `._zod`, `.shape`, Standard Schema (`~standard`), `instanceof`, `.meta()` / `z.globalRegistry`, and `z.toJSONSchema()` all still work. Libraries that accept Zod schemas (tRPC, Hono, React Hook Form) work without changes.

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

**Structural dedup within a file.** Beyond the shared runtime layer, schemas in
the same file that contain a structurally identical sub-tree — a reused
`Address`, a `Money` pair, an exported schema also embedded in another — emit
that shape's error-collecting walk **once** as a shared function and call it
from every occurrence. Only the cold error path is shared (it's 60–80% of the
generated bytes); the zero-allocation fast path stays fully inlined, so valid
input runs exactly as fast as before. On a realistic schema set where
`User`/`Company`/`Order`/`Invoice` reuse `Address`/`Money`/`Contact`, generated
output drops **~50% raw / ~34% gzipped** with no change to validation behavior.

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

### Fully Compiled (2-75x faster)

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

### Behavioral Differences from Zod

Compiled validators match Zod on accept/reject decisions, output data for the known shape, and error messages — including issue ordering for multi-failure inputs. A few observable behaviors differ **by design**, all stemming from the zero-allocation fast path: a successful parse returns the **input value itself** rather than rebuilding it.

| Behavior                               | Zod                              | zod-compiler                                                                     |
| -------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| Unknown keys on a default `z.object()` | Stripped from the output         | **Kept** — the input object is returned by reference                             |
| Record key iteration                   | All own keys (`Reflect.ownKeys`) | Own **enumerable string** keys only — symbol and non-enumerable keys are ignored |
| Array / object output identity         | A fresh value                    | The input value, returned by reference                                           |

What this means in practice:

- **Unknown keys are not stripped.** `z.object({ a: z.string() }).parse({ a: "x", b: 1 })` returns `{ a: "x" }` under Zod but `{ a: "x", b: 1 }` compiled. If you rely on stripping to sanitize untrusted input, use `z.strictObject()` (rejects unknown keys) or `z.looseObject()` (keeps them, making the compiled behavior explicit) — both compile fully. Validation of the declared keys is identical either way.
- **Records skip symbol / non-enumerable keys.** `z.record(z.string(), …)` validates (and rejects) a symbol-keyed or non-enumerable-keyed entry under Zod; the compiled record never visits it. Plain string-keyed records — the common case — are unaffected.

Matching Zod on these would mean allocating a fresh object (or a `Reflect.ownKeys` array) on every successful parse — the exact cost the fast path exists to avoid.

## Benchmark

5-way comparison: **Zod v3** vs **Zod v4** vs **zod-compiler** vs **[Typia](https://typia.io/)** vs **[AJV](https://ajv.js.org/)**

| Scenario                                          | Zod v3 | Zod v4 | **zod-compiler** | Typia | AJV   | vs Zod v4 |
| ------------------------------------------------- | ------ | ------ | ---------------- | ----- | ----- | --------- |
| simple string                                     | 13.3M  | 14.4M  | **16.2M**        | 17.7M | 17.8M | 1.1x      |
| string (min/max)                                  | 13.0M  | 8.0M   | **17.2M**        | 18.1M | 16.3M | 2.2x      |
| number (int+positive)                             | 11.5M  | 7.8M   | **15.7M**        | 16.4M | 16.7M | 2.0x      |
| enum                                              | 11.3M  | 12.3M  | **16.9M**        | 17.2M | 17.6M | 1.4x      |
| bigint (min/max)                                  | 11.8M  | 7.9M   | **15.7M**        | —     | —     | 2.0x      |
| tuple [string, int, bool]                         | 6.0M   | 6.5M   | **17.0M**        | 16.2M | 16.5M | 2.6x      |
| record\<string, number\>                          | 3.3M   | 2.8M   | **8.5M**         | 11.5M | 15.1M | 3.0x      |
| set\<string\> (5 items)                           | 3.7M   | 2.3M   | **15.2M**        | —     | —     | 6.7x      |
| set\<string\> (20 items)                          | 1.3M   | 695K   | **12.1M**        | —     | —     | **17x**   |
| map\<string, number\> (5 entries)                 | 2.1M   | 1.4M   | **13.1M**        | —     | —     | 9.6x      |
| map\<string, number\> (20 entries)                | 652K   | 361K   | **8.6M**         | —     | —     | **24x**   |
| pipe (non-transform)                              | 8.8M   | 5.9M   | **16.1M**        | —     | —     | 2.7x      |
| discriminatedUnion (3 variants)                   | 3.3M   | 4.0M   | **16.1M**        | 15.8M | 8.0M  | 4.0x      |
| discriminatedUnion (8 variants, rotating)         | 2.7M   | 3.5M   | **9.6M**         | —     | —     | 2.7x      |
| plain union of 8 tagged objects (auto-discrim.)   | 368K   | 655K   | **8.6M**         | —     | —     | **13x**   |
| strict object (DB row)                            | 1.8M   | 3.2M   | **7.3M**         | —     | —     | 2.3x      |
| medium object (valid)                             | 2.0M   | 2.4M   | **10.3M**        | 11.4M | 7.7M  | 4.3x      |
| medium object (invalid)                           | 536K   | 80K    | **15.5M**        | 2.9M  | 7.9M  | **194x**  |
| large object (10 items)                           | 123K   | 174K   | **8.0M**         | 5.9M  | 1.3M  | **46x**   |
| large object (100 items)                          | 13K    | 19K    | **1.4M**         | 1.3M  | 127K  | **73x**   |
| recursive tree (7 nodes)                          | 547K   | 2.0M   | **11.8M**        | 11.7M | 4.7M  | 5.8x      |
| recursive tree (121 nodes)                        | 32K    | 142K   | **2.3M**         | 1.9M  | 356K  | **16x**   |
| deeply nested object (243 leaves)                 | 11K    | 19K    | **1.2M**         | 1.0M  | 122K  | **64x**   |
| event log (combined)                              | 382K   | 618K   | **5.8M**         | —     | —     | 9.4x      |
| object with transform (zero-capture)              | 1.2M   | 1.9M   | **6.1M**         | —     | —     | 3.3x      |
| array 10 × transform (zero-capture)               | 129K   | 220K   | **3.4M**         | —     | —     | **15x**   |
| array 50 × transform (zero-capture)               | 26K    | 44K    | **821K**         | —     | —     | **19x**   |
| object with captured transform (partial fallback) | 1.4M   | 6.4M   | **6.2M**         | —     | —     | 1.0x      |

_ops/s, higher is better. "—" = not supported by the library. Measured with `vitest bench` on Apple M4 Max (zod 4.3.6, zod v3 3.23.8, typia 12, ajv 8)._

Performance scales with schema complexity. Nested objects and arrays see the biggest gains because zod-compiler eliminates per-node traversal overhead. Deeply nested schemas (the 243-leaf dashboard row) stay fast because oversized fast-check functions are split into smaller boolean helpers, each kept within V8's optimizing-compiler budget. `discriminatedUnion` uses O(1) `switch` dispatch instead of Zod's sequential trial, and each case validates only its variant's distinctive fields — the object type-guard and the discriminator are checked once before dispatch, never re-checked inside the matched case (a redundancy the engine only elides on unions small enough to inline, so large unions get a measured ~1.5x on the fast check). A **plain `z.union`** of objects that all pin a shared key to disjoint literals is auto-detected and lowered to the same switch dispatch — so an untagged union written without `discriminatedUnion` still validates in O(1) (13x faster than Zod here), as long as it has enough options to outweigh the switch's setup cost; below that it keeps the fully-inlined `||`-chain. The invalid-input row is large because failed `safeParse` defers error materialization until `.error` is read. Zero-capture `transform`/`refine` callbacks are compiled (3-19x); schemas with captured callbacks fall back per-field and roughly match Zod.

`parse()` (throwing API) rides a zero-allocation fast path: medium object 2.3M → 9.7M ops/s (4.1x), large object (100 items) 17K → 1.4M ops/s (79x).

```bash
pnpm benchmark   # run locally
```

### Performance Architecture

For eligible schemas, zod-compiler generates a **two-phase validator**:

1. **Fast Path** — A single `&&` expression chain that validates the entire input with zero allocations. Valid input returns immediately.
2. **Slow Path** — Error-collecting validation that only runs when the Fast Path fails.

Additional optimizations: check ordering (cheap checks first), pre-compiled regex, Set-based enum lookups, small enum inlining (`===` for up to 5 values), discriminated-union cases that skip the now-redundant object-guard and discriminator re-check after `switch` dispatch, and auto-discrimination of plain `z.union`s of tagged objects into the same switch dispatch.

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
