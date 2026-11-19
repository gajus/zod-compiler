import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import type { UnpluginContextMeta, UnpluginOptions } from "unplugin";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { loadSourceFile } from "#src/loader.js";
import { unplugin } from "#src/unplugin/index.js";
import { transformCode, transformCodeWithMap } from "#src/unplugin/transform.js";
import type { BuildStats, TransformOptions } from "#src/unplugin/types.js";
import { expectParses } from "../expect-parses.js";
import { transformHandler } from "./hooks.js";

/**
 * Module-scope schemas that export discovery cannot see, compiled where they
 * stand: the argument of `t.procedure.input(…)`, the private `const Body` a
 * handler validates with. (What the scan reports and why is pinned in
 * module-scope.test.ts; this is what the transform does with the report.)
 *
 * Three things are being held to here. The schema is compiled — it was plain
 * Zod before, however hot the path through it. It is compiled ONCE — a private
 * binding that is also an export, or an alias of one, is discovery's. And
 * nothing else about the module changes — the expression is evaluated where it
 * was written, in the order it was written, and what comes out is the same
 * object it always built.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Inside the repo tree so `zod` resolves, for discovery (which executes the
// file it is given) and for executing the output.
const ROOT = mkdtempSync(path.join(__dirname, "..", "fixtures", ".module-scope-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// Stand-ins for the libraries a schema is handed to. Imported, because that
// is the case hoisting leaves alone: a chain rooted at an import, at module
// scope, already runs once.
writeFileSync(
  path.join(ROOT, "lib.ts"),
  `
export const t = {
  procedure: {
    input: <S>(schema: S) => ({
      schema,
      query: <F>(fn: F) => ({ schema, fn }),
      mutation: <F>(fn: F) => ({ schema, fn }),
    }),
  },
  router: <R>(routes: R): R => routes,
};
export const app = { post: (...args: unknown[]): unknown[] => args };
export const zValidator = <S>(target: string, schema: S) => ({ target, schema });
export const lib = { same: <T>(value: T): T => value, box: <T>(value: T) => ({ value }) };
export function recorder() {
  const log: string[] = [];
  return { log, note: <T>(label: string, value?: T): T => (log.push(label), value as T) };
}
`,
);

const ZOD = `import { z } from "zod";`;
const LIB = `import { app, lib, recorder, t, zValidator } from "../lib";`;
const AUTO: TransformOptions = { mode: "lean", autoDiscover: true };

let serial = 0;
function write(lines: readonly string[]): { file: string; source: string } {
  const directory = path.join(ROOT, `m${serial++}`);
  mkdirSync(directory);
  const file = path.join(directory, "mod.ts");
  const source = lines.join("\n");
  writeFileSync(file, source);
  return { file, source };
}

/** Transform a module written next to the stubs; whatever comes out has to parse. */
async function transform(lines: readonly string[], options = AUTO): Promise<string | null> {
  const { file, source } = write(lines);
  const out = await transformCode(source, file, options);
  if (out !== null) expectParses(out);
  return out;
}

/** One `__zcMkv(` per validator: in lean mode the factory is imported, never declared. */
function validators(out: string | null): number {
  return out === null ? 0 : (out.match(/__zcMkv\(/g) ?? []).length;
}

/** `expression` has become the schema a validator is installed on, right where it stood. */
function compiledInPlace(out: string | null, before: string, expression: string): void {
  const start = `${before}/* @__PURE__ */ (() => {`;
  expect(out).toContain(start);
  // The IIFE closes on the factory call, and its target is the expression as
  // written (`__zs` when the validator also reads the schema, and then `__zs`
  // is bound to that same text).
  const body = (out ?? "").slice((out ?? "").indexOf(start) + start.length);
  const iife = body.slice(0, body.indexOf("\n})()"));
  expect(iife).toMatch(/return (?:__zcZr\()?__zcMkv\(safeParse_\w+,/);
  expect(iife.includes(`__zcMkv(${/safeParse_\w+/.exec(iife)?.[0]},${expression},`)).toBe(
    !iife.includes(`var __zs=${expression};`),
  );
}

interface Executed {
  original: Record<string, unknown>;
  compiled: Record<string, unknown>;
  out: string;
}

/**
 * Execute a module as written and as transformed (inline helpers, so the
 * output runs without a bundler). Each module exports `run()`; the two have to
 * agree on what it returns.
 */
async function execute(
  lines: readonly string[],
  options?: Partial<TransformOptions>,
): Promise<Executed> {
  const { file, source } = write(lines);
  const out = await transformCode(source, file, { mode: "inline", autoDiscover: true, ...options });
  expect(out).not.toBeNull();
  expectParses(out as string);
  const outFile = path.join(path.dirname(file), "out.ts");
  writeFileSync(outFile, out as string);
  const original = await loadSourceFile(file);
  const compiled = await loadSourceFile(outFile);
  expect((compiled["run"] as () => unknown)()).toEqual((original["run"] as () => unknown)());
  return { original, compiled, out: out as string };
}

/** A compiled validator answers `.is()`; a plain Zod schema has no such method. */
function isCompiled(schema: unknown): boolean {
  return typeof (schema as { is?: unknown }).is === "function";
}

/** What a parse comes to, in a shape two runs can be compared by. */
const REPORT = [
  `function report(schema: { safeParse(v: unknown): any }, value: unknown) {`,
  `  const result = schema.safeParse(value);`,
  `  return result.success`,
  `    ? { data: result.data }`,
  `    : { issues: result.error.issues.map((i: any) => [i.code, i.path.join("."), i.message]) };`,
  `}`,
];

describe("module-scope schemas no export reaches are compiled where they stand", () => {
  it("the input of a procedure", async () => {
    const out = await transform([
      ZOD,
      LIB,
      `export const create = t.procedure.input(z.object({ name: z.string().min(1) })).mutation(() => 1);`,
    ]);

    expect(validators(out)).toBe(1);
    compiledInPlace(out, "t.procedure.input(", "z.object({ name: z.string().min(1) })");
    expect(out).toContain(`})()).mutation(() => 1);`);
  });

  it("each procedure of a router", async () => {
    const out = await transform([
      ZOD,
      LIB,
      `export const appRouter = t.router({`,
      `  create: t.procedure.input(z.object({ name: z.string() })).mutation(() => 1),`,
      `  byId: t.procedure.input(z.string().uuid()).query(() => 2),`,
      `});`,
    ]);

    expect(validators(out)).toBe(2);
    compiledInPlace(out, "create: t.procedure.input(", "z.object({ name: z.string() })");
    compiledInPlace(out, "byId: t.procedure.input(", "z.string().uuid()");
  });

  it("the validator of a route", async () => {
    const out = await transform([
      ZOD,
      LIB,
      `app.post("/things", zValidator("json", z.object({ id: z.number() })), () => 1);`,
    ]);

    expect(validators(out)).toBe(1);
    compiledInPlace(out, `app.post("/things", zValidator("json", `, "z.object({ id: z.number() })");
  });

  it("a private binding a handler validates with", async () => {
    const out = await transform([
      ZOD,
      `const Body = z.object({ id: z.number() });`,
      `export function handler(input: unknown) { return Body.parse(input); }`,
    ]);

    expect(validators(out)).toBe(1);
    compiledInPlace(out, "const Body = ", "z.object({ id: z.number() })");
    // Named after the binding, as an export's validator is after the export.
    expect(out).toContain("function safeParse_Body(input)");
    expect(out).toContain(`export function handler(input: unknown) { return Body.parse(input); }`);
  });

  it("a private binding whose name a generated function cannot carry", async () => {
    // The validator's functions are named after the binding, by a reader that
    // stops at `$`. The name is only a label: any other serves.
    const out = await transform([
      ZOD,
      `const $Body = z.object({ id: z.number() });`,
      `export const handler = (v: unknown) => $Body.parse(v);`,
    ]);

    expect(validators(out)).toBe(1);
    compiledInPlace(out, "const $Body = ", "z.object({ id: z.number() })");
    expect(out).toMatch(/function safeParse__zi_[0-9a-f]{8}\(input\)/);
  });

  it("the same schema written twice, each where it is", async () => {
    const out = await transform([
      ZOD,
      LIB,
      `export const a = t.procedure.input(z.object({ id: z.number() })).query(() => 1);`,
      `export const b = t.procedure.input(z.object({ id: z.number() })).query(() => 2);`,
    ]);

    expect(validators(out)).toBe(2);
    expect(out?.match(/t\.procedure\.input\(\/\* @__PURE__ \*\//g)).toHaveLength(2);
  });

  it("beside a schema hoisted out of a function and an exported one, each exactly once", async () => {
    // Three stages have rewritten the file by the time the in-place edits go
    // in — the hoist, the hoisted schema's compile, the export's — and their
    // offsets were taken from the file as written.
    const out = await transform([
      ZOD,
      LIB,
      `export const Exported = z.object({ id: z.number() });`,
      `export const a = t.procedure.input(z.object({ name: z.string() })).query(() => 1);`,
      `export function f(v: unknown) { return z.object({ flag: z.boolean() }).safeParse(v).success; }`,
      `const Body = z.string().min(2);`,
      `export const g = (v: unknown) => Body.safeParse(v).success;`,
    ]);

    expect(validators(out)).toBe(4);
    compiledInPlace(out, "export const Exported = ", "z.object({ id: z.number() })");
    compiledInPlace(out, "export const a = t.procedure.input(", "z.object({ name: z.string() })");
    compiledInPlace(out, "const Body = ", "z.string().min(2)");
    expect(out).toMatch(/const _zh_[0-9a-f]{8} = \/\* @__PURE__ \*\/ \(\(\) => \{/);
    expect(out).toMatch(/return _zh_[0-9a-f]{8}\.safeParse\(v\)\.success;/);
  });

  it("imports every helper its validators name", async () => {
    // A lean-mode file gets its helpers from the runtime module, and one it
    // forgot to import is a ReferenceError the first time a schema is parsed
    // with. Checked on a file discovery never rewrites, and on one it does.
    for (const lines of [
      [ZOD, `const Body = z.string().uuid();`, `export const f = (v: unknown) => Body.parse(v);`],
      [
        ZOD,
        LIB,
        `export const Exported = z.object({ id: z.number() });`,
        `export const a = t.procedure.input(z.string().email()).query(() => 1);`,
      ],
    ]) {
      const out = (await transform(lines)) ?? "";
      const [imported] =
        /^import \{ ([^}]*) \} from "virtual:zod-compiler\/runtime";$/m.exec(out) ?? [];
      expect(imported).toBeDefined();
      const names = new Set(/\{ ([^}]*) \}/.exec(imported as string)?.[1]?.split(", "));
      const used = new Set(out.replace(imported as string, "").match(/\b__zc[A-Za-z]+\b/g));
      expect([...used].filter((name) => !names.has(name))).toEqual([]);
      expect(names.has("__zcMkv")).toBe(true);
    }
  });
});

describe("a schema is compiled once", () => {
  it("an export is discovery's alone", async () => {
    const out = await transform([ZOD, `export const User = z.object({ id: z.number() });`]);
    expect(validators(out)).toBe(1);
  });

  it("a binding exported by name is compiled at its declaration, once", async () => {
    const out = await transform([
      ZOD,
      `const User = z.object({ id: z.number() });`,
      `export { User };`,
    ]);

    expect(validators(out)).toBe(1);
    compiledInPlace(out, "const User = ", "z.object({ id: z.number() })");
  });

  it("the members of a default-exported table are each compiled once", async () => {
    const out = await transform([
      ZOD,
      `const A = z.object({ id: z.number() });`,
      `const B = z.object({ name: z.string() });`,
      `export default { A, B };`,
    ]);

    expect(validators(out)).toBe(2);
    compiledInPlace(out, "const A = ", "z.object({ id: z.number() })");
    compiledInPlace(out, "const B = ", "z.object({ name: z.string() })");
  });

  it("a binding only other schemas are built from stays plain Zod", async () => {
    const out = await transform([
      ZOD,
      `const Base = z.object({ id: z.number(), name: z.string() });`,
      `const Tag = z.string().min(1);`,
      `export const Picked = Base.pick({ id: true });`,
      `export const Tagged = z.object({ tags: z.array(Tag) });`,
    ]);

    // The two exports, and nothing for the bindings they were built from:
    // each export's validator covers the whole of it.
    expect(validators(out)).toBe(2);
    expect(out).toContain(`const Base = z.object({ id: z.number(), name: z.string() });`);
    expect(out).toContain(`const Tag = z.string().min(1);`);
  });

  it("but one that is also validated with gets a validator of its own", async () => {
    const out = await transform([
      ZOD,
      `const Base = z.object({ id: z.number(), name: z.string() });`,
      `export const Picked = Base.pick({ id: true });`,
      `export const check = (v: unknown) => Base.safeParse(v);`,
    ]);

    expect(validators(out)).toBe(2);
    compiledInPlace(out, "const Base = ", "z.object({ id: z.number(), name: z.string() })");
  });

  it("a binding exported under another name is compiled through that export", async () => {
    const out = await transform([
      ZOD,
      `const Body = z.object({ id: z.number() });`,
      `export const BodySchema = Body;`,
      `export const check = (v: unknown) => Body.safeParse(v);`,
    ]);

    // One validator, installed on the object both names hold.
    expect(validators(out)).toBe(1);
    expect(out).toContain(`const Body = z.object({ id: z.number() });`);
    expect(out).toContain(`export const BodySchema = /* @__PURE__ */ (() => {`);
  });

  it("a binding handed to compile() is compiled through that call", async () => {
    const out = await transform([
      ZOD,
      `import { compile } from "zod-compiler";`,
      `const UserSchema = z.object({ id: z.number() });`,
      `export const validateUser = compile(UserSchema);`,
    ]);

    expect(validators(out)).toBe(1);
    expect(out).toContain(`const UserSchema = z.object({ id: z.number() });`);
    expect(out).toContain(`export const validateUser = /* @__PURE__ */ (() => {`);
  });

  it("an argument inside an export discovery compiled is that export", async () => {
    // `lib.same` hands its argument back, so `Same` IS the schema: discovery
    // finds it and wraps the whole initializer.
    const out = await transform([
      ZOD,
      LIB,
      `export const Same = lib.same(z.object({ id: z.number() }));`,
    ]);

    expect(validators(out)).toBe(1);
    compiledInPlace(out, "export const Same = ", "lib.same(z.object({ id: z.number() }))");
  });

  it("while an argument inside an export that is not a schema is compiled itself", async () => {
    const out = await transform([
      ZOD,
      LIB,
      `export const Boxed = lib.box(z.object({ id: z.number() }));`,
    ]);

    expect(validators(out)).toBe(1);
    compiledInPlace(out, "export const Boxed = lib.box(", "z.object({ id: z.number() })");
  });

  it("a binding exported under a name discovery cannot place is compiled at its declaration", async () => {
    // `export { A as B }` and `export default A` name no declaration to
    // rewrite; before this they were left as plain Zod.
    for (const exported of [`export { User as UserSchema };`, `export default User;`]) {
      const out = await transform([ZOD, `const User = z.object({ id: z.number() });`, exported]);
      expect(validators(out)).toBe(1);
      compiledInPlace(out, "const User = ", "z.object({ id: z.number() })");
    }
  });
});

describe("what stays exactly as written", () => {
  const PLACEMENTS = [
    [
      "an argument",
      [
        ZOD,
        LIB,
        `export const create = t.procedure.input(z.object({ name: z.string() })).mutation(() => 1);`,
      ],
    ],
    [
      "a route's validator",
      [ZOD, LIB, `app.post("/x", zValidator("json", z.object({ id: z.number() })), () => 1);`],
    ],
    [
      "a private binding",
      [
        ZOD,
        `const Body = z.object({ id: z.number() });`,
        `export function handler(input: unknown) { return Body.parse(input); }`,
      ],
    ],
  ] as const;

  it.each(PLACEMENTS)('%s under schemas: "explicit"', async (_what, lines) => {
    // Nothing here is wrapped in compile(), and nothing is inside a function.
    expect(await transform(lines, { mode: "lean", autoDiscover: false })).toBeNull();
  });

  it.each(PLACEMENTS)("%s is compiled with hoisting switched off", async (_what, lines) => {
    // Compiling in place moves nothing, so `hoist: false` has no say in it.
    expect(validators(await transform(lines, { ...AUTO, hoist: false }))).toBe(1);
  });

  it("a schema in a function, with hoisting switched off, beside one compiled in place", async () => {
    const out = await transform(
      [
        ZOD,
        `const Body = z.string().min(2);`,
        `export const g = (v: unknown) => Body.safeParse(v).success;`,
        `export function f(v: unknown) { return z.object({ flag: z.boolean() }).safeParse(v).success; }`,
      ],
      { ...AUTO, hoist: false },
    );

    expect(validators(out)).toBe(1);
    expect(out).not.toContain("_zh_");
    expect(out).toContain(`return z.object({ flag: z.boolean() }).safeParse(v).success;`);
  });

  it("an expression that reaches for anything but zod", async () => {
    // What a schema is built from decides what it validates, and only zod's
    // own bindings are known to be the same at build time as at run time.
    const lines = [
      ZOD,
      LIB,
      `const Name = z.string();`,
      `const limit = Number(process.env["LIMIT"] ?? 3);`,
      `export const create = t.procedure.input(z.object({ name: Name })).mutation(() => 1);`,
      `export const list = t.procedure.input(z.array(z.string()).max(limit)).query(() => 2);`,
      `const Body = z.object({ name: Name });`,
      `export const handler = (v: unknown) => Body.parse(v);`,
    ];
    expect(await transform(lines)).toBeNull();
  });

  it("a schema that refers to itself", async () => {
    // Built in isolation at build time, the reference to its own binding has
    // nothing to resolve to. It keeps working as plain Zod.
    const { out } = await execute([
      ZOD,
      ...REPORT,
      `const Tree = z.object({ value: z.string(), get children() { return z.array(Tree); } });`,
      `const Chain: z.ZodType = z.lazy(() => z.object({ next: Chain.optional() }));`,
      `const Leaf = z.object({ value: z.string() });`,
      `export function run() {`,
      `  return [`,
      `    report(Tree, { value: "a", children: [{ value: "b", children: [] }] }),`,
      `    report(Tree, { value: "a", children: [{ value: 1, children: [] }] }),`,
      `    report(Chain, { next: { next: {} } }),`,
      `    report(Chain, { next: { next: 1 } }),`,
      `    report(Leaf, { value: 1 }),`,
      `  ];`,
      `}`,
    ]);

    expect(out).toContain(`const Tree = z.object({ value: z.string(), get children()`);
    expect(out).toContain(`const Chain: z.ZodType = z.lazy(`);
    expect(out).toContain(`const Leaf = /* @__PURE__ */ (() => {`);
  });
});

describe("the module behaves as it did", () => {
  it("validates the same, through schemas that are now compiled", async () => {
    const { original, compiled } = await execute([
      ZOD,
      LIB,
      ...REPORT,
      `export const appRouter = t.router({`,
      `  create: t.procedure`,
      `    .input(z.object({ name: z.string().min(1), tags: z.array(z.string()).max(2) }))`,
      `    .mutation(({ input }: { input: unknown }) => input),`,
      `  byId: t.procedure.input(z.string().uuid()).query(() => 2),`,
      `});`,
      `export const posted = app.post("/things", zValidator("json", z.object({ id: z.number().int().positive() })), () => 1);`,
      `const Body = z.object({ id: z.number(), email: z.string().email() });`,
      `type Body = z.infer<typeof Body>;`,
      `export function handler(input: unknown): Body { return Body.parse(input); }`,
      `function thrown(fn: () => unknown) {`,
      `  try { return { returned: fn() }; }`,
      `  catch (error: any) { return { zodError: error instanceof z.ZodError, issues: error.issues.length }; }`,
      `}`,
      `export const schemas = {`,
      `  create: appRouter.create.schema,`,
      `  byId: appRouter.byId.schema,`,
      `  body: (posted[1] as { schema: z.ZodType }).schema,`,
      `  Body,`,
      `};`,
      `export function run() {`,
      `  return [`,
      `    report(schemas.create, { name: "a", tags: ["x"], extra: 1 }),`,
      `    report(schemas.create, { name: "", tags: ["x", "y", "z"] }),`,
      `    report(schemas.create, null),`,
      `    report(schemas.byId, "6b0e8a6e-9c1d-4d1c-8c0f-0f6f3b9f2a11"),`,
      `    report(schemas.byId, "nope"),`,
      `    report(schemas.body, { id: 1 }),`,
      `    report(schemas.body, { id: -1.5 }),`,
      `    thrown(() => handler({ id: 1, email: "a@b.co" })),`,
      `    thrown(() => handler({ id: "1", email: "nope" })),`,
      `  ];`,
      `}`,
    ]);

    const before = original["schemas"] as Record<string, unknown>;
    const after = compiled["schemas"] as Record<string, unknown>;
    for (const name of ["create", "byId", "body", "Body"]) {
      expect(isCompiled(before[name]), `${name}, as written`).toBe(false);
      expect(isCompiled(after[name]), `${name}, transformed`).toBe(true);
    }
  });

  it("evaluates each expression where it was written, in the order it was written", async () => {
    // Every statement here leaves a mark, and the schemas' own side effect —
    // registering their metadata — is read back by the statement after each.
    const { compiled } = await execute([
      ZOD,
      LIB,
      `const { log, note } = recorder();`,
      `note("top");`,
      `const First = z.string().min(1).meta({ title: "first" });`,
      "note(`after First: ${z.globalRegistry.get(First)?.title}`);",
      `export const posted = app.post(`,
      `  note("path", "/x"),`,
      `  zValidator("json", z.object({ id: z.number() }).meta({ title: "second" })),`,
      `  note("handler", () => 1),`,
      `);`,
      `const second = (posted[1] as { schema: z.ZodType }).schema;`,
      "note(`after posted: ${z.globalRegistry.get(second)?.title}`);",
      // A callback may name a binding declared further down: it does not run
      // until something is parsed, and it must not start running sooner.
      `const Bounded = z.number().refine((v) => v < limit);`,
      `note("before limit");`,
      `const limit = 10;`,
      "note(`bounded: ${Bounded.safeParse(3).success} ${Bounded.safeParse(30).success}`);",
      `export const schemas = { First, second };`,
      `export function run() {`,
      `  return {`,
      `    log: [...log],`,
      `    first: [First.safeParse("x").success, First.safeParse("").success],`,
      `    route: posted[0],`,
      `  };`,
      `}`,
    ]);

    expect((compiled["run"] as () => { log: string[] })().log).toEqual([
      "top",
      "after First: first",
      "path",
      "handler",
      "after posted: second",
      "before limit",
      "bounded: true false",
    ]);
    const { First, second } = compiled["schemas"] as Record<string, unknown>;
    expect(isCompiled(First)).toBe(true);
    expect(isCompiled(second)).toBe(true);
  });

  it("builds the same object: still a Zod schema, still what other schemas are built from", async () => {
    const { compiled } = await execute([
      ZOD,
      LIB,
      ...REPORT,
      `const Base = z.object({ id: z.number() });`,
      `export const viaBase = (v: unknown) => Base.safeParse(v).success;`,
      `export const made = t.procedure.input(z.object({ name: z.string() })).query(() => 1);`,
      // Built from the compiled binding inside a function, so not hoisted and
      // not compiled: plain Zod, standing on a compiled schema.
      `export function wider() { return Base.extend({ name: z.string() }); }`,
      `export const schemas = { Base, input: made.schema };`,
      `export function run() {`,
      `  return {`,
      `    instances: [Base instanceof z.ZodObject, made.schema instanceof z.ZodType],`,
      `    shapes: [Object.keys(Base.shape), Object.keys(made.schema.shape)],`,
      `    json: z.toJSONSchema(Base),`,
      `    wider: [report(wider(), { id: 1, name: "a" }), report(wider(), { id: "1" })],`,
      `    nested: report(z.array(Base), [{ id: 1 }, { id: "2" }]),`,
      `  };`,
      `}`,
    ]);

    const { Base, input } = compiled["schemas"] as Record<string, unknown>;
    expect(isCompiled(Base)).toBe(true);
    expect(isCompiled(input)).toBe(true);
  });

  it('under output: "compact", with errors still Zod\'s own', async () => {
    const { out, compiled } = await execute(
      [
        ZOD,
        LIB,
        ...REPORT,
        `const Body = z.object({ id: z.number(), email: z.string().email() });`,
        `export const made = t.procedure.input(z.object({ name: z.string().min(1) })).query(() => 1);`,
        `export const schemas = { Body, input: made.schema };`,
        `export function run() {`,
        `  return [`,
        `    report(Body, { id: 1, email: "a@b.co" }),`,
        `    report(Body, { id: "1", email: "nope" }),`,
        `    report(made.schema, { name: "a" }),`,
        `    report(made.schema, { name: "" }),`,
        `  ];`,
        `}`,
      ],
      { compact: true },
    );

    // The cold path is handed to the schema the validator was built from, and
    // the compiled walk that would have produced the issues is not emitted.
    expect(out).toContain("__zcFinZ(");
    expect(out).not.toContain("__sw_");
    const { Body, input } = compiled["schemas"] as Record<string, unknown>;
    expect(isCompiled(Body)).toBe(true);
    expect(isCompiled(input)).toBe(true);
  });
});

describe('output: "bag"', () => {
  const BAG: TransformOptions = { mode: "lean", autoDiscover: true, zodCompat: false };

  it("replaces a binding the file only validates with, and an argument", async () => {
    const out = await transform(
      [
        ZOD,
        LIB,
        `const Body = z.object({ id: z.number() });`,
        `export const handler = (v: unknown) => Body.safeParse(v).success;`,
        `export const made = t.procedure.input(z.object({ name: z.string() })).query(() => 1);`,
      ],
      BAG,
    );

    expect(validators(out)).toBe(2);
    // A bag is built on nothing: no schema is handed to the factory.
    expect(out).toContain("__zcMkv(safeParse_Body,null,");
    expect(out).toMatch(/t\.procedure\.input\(\/\* @__PURE__ \*\/ \(\(\) => \{/);
    expect(out).not.toContain("z.object({ id: z.number() })");
  });

  it.each([
    ["handed on", `app.post("/x", zValidator("json", Body));`],
    ["built upon", `export const Loose = () => Body.partial();`],
    ["read for its shape", `export const keys = () => Object.keys(Body.shape);`],
    ["mentioned where the scanner does not read", `// Body is what the handler checks against`],
  ])("leaves a binding that is %s a schema", async (_what, line) => {
    const out = await transform(
      [
        ZOD,
        LIB,
        `const Body = z.object({ id: z.number() });`,
        `export const handler = (v: unknown) => Body.safeParse(v).success;`,
        line,
        `export const made = t.procedure.input(z.string()).query(() => 1);`,
      ],
      BAG,
    );

    // The argument still compiles; the binding is as it was written.
    expect(validators(out)).toBe(1);
    expect(out).toContain(`const Body = z.object({ id: z.number() });`);
  });

  it("behaves the same where a bag is all that was needed", async () => {
    const { out } = await execute(
      [
        ZOD,
        LIB,
        `const Checked = z.object({ id: z.number() });`,
        `const Passed = z.object({ name: z.string() });`,
        `export const posted = app.post("/x", zValidator("json", Passed));`,
        `export const made = t.procedure.input(z.object({ flag: z.boolean() })).query(() => 1);`,
        `export function run() {`,
        `  return {`,
        `    checked: [Checked.safeParse({ id: 1 }).success, Checked.safeParse({ id: "1" }).success],`,
        `    passed: [Passed instanceof z.ZodObject, Object.keys(Passed.shape)],`,
        `    made: [made.schema.safeParse({ flag: true }).success, made.schema.safeParse({}).success],`,
        `  };`,
        `}`,
      ],
      { zodCompat: false },
    );

    expect(out).toContain(`const Checked = /* @__PURE__ */ (() => {`);
    expect(out).toContain(`const Passed = z.object({ name: z.string() });`);
  });
});

describe("what the build is told", () => {
  async function stats(lines: readonly string[]): Promise<BuildStats[]> {
    const seen: BuildStats[] = [];
    await transform(lines, { ...AUTO, onBuildStats: (s) => seen.push(s) });
    return seen;
  }

  it("counts a schema compiled in place as found and optimized", async () => {
    expect(
      await stats([
        ZOD,
        LIB,
        `const Body = z.object({ id: z.number() });`,
        `export const handler = (v: unknown) => Body.parse(v);`,
        `export const made = t.procedure.input(z.string()).query(() => 1);`,
      ]),
    ).toEqual([{ files: 1, schemas: 2, optimized: 2, failed: 0 }]);
  });

  it("counts one it had to leave as found", async () => {
    expect(
      await stats([
        ZOD,
        LIB,
        `const limit = 3;`,
        `export const a = t.procedure.input(z.string()).query(() => 1);`,
        `export const b = t.procedure.input(z.string().max(limit)).query(() => 2);`,
      ]),
    ).toEqual([{ files: 1, schemas: 2, optimized: 1, failed: 0 }]);
  });

  it("counts a binding discovery compiled once, beside the export it came in under", async () => {
    expect(
      await stats([
        ZOD,
        LIB,
        `const User = z.object({ id: z.number() });`,
        `export { User };`,
        `const UserSchema = z.object({ name: z.string() });`,
        `export const Alias = UserSchema;`,
        `export const made = t.procedure.input(z.string()).query(() => 1);`,
      ]),
    ).toEqual([{ files: 1, schemas: 3, optimized: 3, failed: 0 }]);
  });

  it("names each one under verbose", async () => {
    const logs: string[] = [];
    // oxlint-disable-next-line no-console -- intercept console.log to read the verbose output
    const originalLog = console.log;
    // oxlint-disable-next-line no-console -- install the interception
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await transform(
        [
          ZOD,
          LIB,
          `const Body = z.object({ id: z.number() });`,
          `export const handler = (v: unknown) => Body.parse(v);`,
          `export const made = t.procedure.input(z.string()).query(() => 1);`,
        ],
        { ...AUTO, verbose: true },
      );
    } finally {
      // oxlint-disable-next-line no-console -- restore the intercepted logger
      console.log = originalLog;
    }

    expect(logs).toContain("[zod-compiler]   ✓ Body (module-scope schema compiled in place)");
    expect(
      logs.some((line) => /✓ _zi_[0-9a-f]{8} \(module-scope schema compiled in place\)/.test(line)),
    ).toBe(true);
  });
});

describe("sourcemaps", () => {
  /** 1-based line / 0-based column of the first occurrence of `token`. */
  function positionOf(code: string, token: string): { line: number; column: number } {
    const at = code.indexOf(token);
    if (at === -1) throw new Error(`token not found: ${token}`);
    const before = code.slice(0, at);
    return { line: before.split("\n").length, column: at - (before.lastIndexOf("\n") + 1) };
  }

  it("trace code after an in-place validator back to where it was written", async () => {
    const lines = [
      ZOD, // L1
      LIB, // L2
      `const Body = z.object({ id: z.number() });`, // L3
      `export const handler = (v: unknown) => Body.parse(v) && "sentinel-handler";`, // L4
      `export const made = t.procedure`, // L5
      `  .input(z.object({ name: z.string() }))`, // L6
      `  .query(() => "sentinel-query");`, // L7
      `export function after() { return "sentinel-after"; }`, // L8
    ];
    const { file, source } = write(lines);
    const result = await transformCodeWithMap(source, file, AUTO);
    expect(result).not.toBeNull();
    const { code, map } = result as {
      code: string;
      map: ConstructorParameters<typeof TraceMap>[0];
    };
    // Two validators stand between the top of the file and the last line.
    expect(positionOf(code, `"sentinel-after"`).line).toBeGreaterThan(30);

    const tracer = new TraceMap(map);
    for (const [token, line] of [
      [`"sentinel-handler"`, 4],
      [`"sentinel-query"`, 7],
      [`"sentinel-after"`, 8],
    ] as const) {
      const original = originalPositionFor(tracer, positionOf(code, token));
      expect(original.line, token).toBe(line);
      expect(original.column, token).toBe(positionOf(source, token).column);
    }
  });
});

describe("the build plugin", () => {
  const meta = { framework: "vite" } as UnpluginContextMeta;
  const lines = [
    ZOD,
    LIB,
    `const Body = z.object({ id: z.number() });`,
    `export const handler = (v: unknown) => Body.parse(v);`,
    `export const made = t.procedure.input(z.string()).query(() => 1);`,
  ];

  it("compiles them by default", async () => {
    const { file, source } = write(lines);
    const transformWith = transformHandler(unplugin.raw({ cache: false }, meta) as UnpluginOptions);
    const result = await transformWith(source, file);
    expect(validators(result?.code ?? null)).toBe(2);
  });

  it('leaves them alone under schemas: "explicit"', async () => {
    const { file, source } = write(lines);
    const transformWith = transformHandler(
      unplugin.raw({ cache: false, schemas: "explicit" }, meta) as UnpluginOptions,
    );
    expect((await transformWith(source, file)) ?? null).toBeNull();
  });
});
