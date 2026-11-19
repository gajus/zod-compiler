import { describe, expect, it } from "vite-plus/test";
import { analyzeZodSchemas, hoistZodSchemas } from "#src/unplugin/hoist.js";

/**
 * What `analyzeZodSchemas()` reports for compiling IN PLACE: the schemas built
 * at module scope that export discovery never sees. Two kinds, and the tests
 * are grouped by which they are and by what keeps a look-alike out.
 *
 * The analysis is lexical, so most of what is pinned here is a direction: when
 * the scanner cannot tell, the answer is "not this one", and the schema stays
 * exactly as written.
 */
const ZOD_IMPORT = `import { z } from "zod";`;
const IMPORTS = [
  ZOD_IMPORT,
  `import { t } from "./trpc";`,
  `import { app, zValidator } from "./app";`,
  `import { sql } from "slonik";`,
  `import { Base } from "./base";`,
].join("\n");

function analyze(lines: string[], imports = IMPORTS) {
  return analyzeZodSchemas([imports, ...lines].join("\n"), { moduleScope: true }).moduleScope;
}

/** The text of each ARGUMENT reported, in source order. */
function reported(lines: string[], imports = IMPORTS): string[] {
  return analyze(lines, imports).flatMap((schema) =>
    schema.name === undefined ? [schema.text] : [],
  );
}

/** The private BINDINGS reported, by name. */
function bindings(lines: string[], imports = IMPORTS): string[] {
  return analyze(lines, imports).flatMap((schema) =>
    schema.name === undefined ? [] : [schema.name],
  );
}

describe("analyzeZodSchemas() — an argument of a module-scope chain that is not a schema", () => {
  it("the input of a procedure", () => {
    expect(
      reported([
        `export const create = t.procedure.input(z.object({ name: z.string() })).mutation(() => 1);`,
      ]),
    ).toEqual([`z.object({ name: z.string() })`]);
  });

  it("the same inside a router's object literal", () => {
    expect(
      reported([
        `export const appRouter = t.router({`,
        `  create: t.procedure.input(z.object({ name: z.string() })).mutation(() => 1),`,
        `  byId: t.procedure.input(z.string().uuid()).query(() => 2),`,
        `});`,
      ]),
    ).toEqual([`z.object({ name: z.string() })`, `z.string().uuid()`]);
  });

  it("a validator handed to a route, through a call that is not zod's either", () => {
    expect(
      reported([`app.post("/x", zValidator("json", z.object({ id: z.number() })), () => 1);`]),
    ).toEqual([`z.object({ id: z.number() })`]);
  });

  it("a member of an array or an object literal on the way", () => {
    expect(
      reported([
        `export const routes = app.define({`,
        `  body: z.object({ id: z.number() }),`,
        `  responses: [z.string(), { schema: z.boolean() }],`,
        `});`,
      ]),
    ).toEqual([`z.object({ id: z.number() })`, `z.string()`, `z.boolean()`]);
  });

  it("the argument of a tagged-template chain, and an expression of the template", () => {
    expect(
      reported([
        "export const q = sql.type(z.object({ id: z.number() }))`SELECT ${app.bind(z.string())} AS id`;",
      ]),
    ).toEqual([`z.object({ id: z.number() })`, `z.string()`]);
  });

  it("either branch of a conditional, and what a spread spreads", () => {
    expect(
      reported([
        `app.use(process.env.STRICT ? z.strictObject({ a: z.string() }) : z.object({ a: z.string() }));`,
        `app.all(...[z.number()]);`,
      ]),
    ).toEqual([`z.strictObject({ a: z.string() })`, `z.object({ a: z.string() })`, `z.number()`]);
  });

  it("only the outermost schema: what is inside it is part of it", () => {
    expect(
      reported([
        `app.post("/x", zValidator("json", z.object({ tags: z.array(z.string()), id: z.union([z.string(), z.number()]) })));`,
        // A spread schema is still a schema, and its members still its parts.
        `app.define({ ...z.object({ a: z.string(), b: z.number() }) });`,
      ]),
    ).toEqual([
      `z.object({ tags: z.array(z.string()), id: z.union([z.string(), z.number()]) })`,
      `z.object({ a: z.string(), b: z.number() })`,
    ]);
  });

  it("in a file that leaves out its semicolons", () => {
    expect(
      reported([
        `const double = (n: number) => n * 2`,
        `app.post("/x", zValidator("json", z.object({ id: z.number() })))`,
        `app.get("/y", zValidator("query", z.object({ q: z.string() })))`,
      ]),
    ).toEqual([`z.object({ id: z.number() })`, `z.object({ q: z.string() })`]);
  });

  it("with TypeScript after the construction, which stays where it is", () => {
    expect(
      reported([`app.post("/x", zValidator("json", z.object({ id: z.number() }) as never));`]),
    ).toEqual([`z.object({ id: z.number() })`]);
  });

  it("with a callback of its own, which may reach for anything", () => {
    expect(
      reported([
        `const limit = 3;`,
        `app.post("/x", zValidator("json", z.string().refine((v) => v.length < limit)));`,
      ]),
    ).toEqual([`z.string().refine((v) => v.length < limit)`]);
  });

  it("gives every extent in the coordinates of the source it was handed", () => {
    const code = [
      IMPORTS,
      `const Body = z.object({ id: z.number() });`,
      `export const create = t.procedure.input(z.string().min(1)).query(() => Body.parse(1));`,
    ].join("\n");
    const found = analyzeZodSchemas(code, { moduleScope: true }).moduleScope;
    expect(found).toHaveLength(2);
    for (const schema of found) {
      expect(code.slice(schema.start, schema.end)).toBe(schema.text);
    }
    // Source order, whichever kind each is.
    expect(found.map((schema) => schema.text)).toEqual([
      `z.object({ id: z.number() })`,
      `z.string().min(1)`,
    ]);
  });

  it("names an argument's validator after its text, and a binding's after the binding", () => {
    const found = analyze([
      `const Body = z.object({ id: z.number() });`,
      `export const a = t.procedure.input(z.string()).query(() => Body.parse(1));`,
      `export const b = t.procedure.input(z.string()).query(() => 2);`,
    ]);
    const [body, first, second] = found;
    expect(body?.label).toBe("Body");
    expect(first?.label).toMatch(/^_zi_[0-9a-f]{8}$/);
    // The same text twice is the same schema twice: one compile serves both.
    expect(second?.label).toBe(first?.label);
  });
});

describe("analyzeZodSchemas() — not an argument that runs more than once, or might", () => {
  it("the body of a callback, block or concise", () => {
    expect(
      reported([
        `app.post("/x", (c: unknown) => { return app.check(z.object({ id: z.number() }), c); });`,
        `app.post("/y", (c: unknown) => app.check(z.object({ id: z.number() }), c));`,
        `app.post("/z", function (c: unknown) { return app.check(z.object({ id: z.number() }), c); });`,
        `app.post("/w", async (c: unknown) => ({ body: z.string() }));`,
      ]),
    ).toEqual([]);
  });

  it("a callback beside an argument that does compile", () => {
    expect(
      reported([
        `export const r = t.router({`,
        `  create: t.procedure`,
        `    .input(z.object({ name: z.string() }))`,
        `    .mutation(({ input }: { input: unknown }) => app.check(z.object({ ok: z.boolean() }), input)),`,
        `  list: t.procedure.input(z.number()).query(() => 1),`,
        `});`,
      ]),
    ).toEqual([`z.object({ name: z.string() })`, `z.number()`]);
  });

  it("a method, a getter or a class in the arguments", () => {
    expect(
      reported([
        `app.define({`,
        `  check(v: unknown) { return app.check(z.string(), v); },`,
        `  get schema() { return z.number(); },`,
        `  async load() { return z.bigint(); },`,
        `  holder: class { static s = z.boolean(); },`,
        `});`,
      ]),
    ).toEqual([]);
  });

  it("a body that follows a return type", () => {
    // A `{` after `>` or `]` reads like an object literal's; after a parameter
    // list and its return type it is a body.
    expect(
      reported([
        `app.post("/a", function (c: unknown): Promise<unknown> { return app.check(z.string(), c); });`,
        `app.post("/b", async (c: unknown): Promise<Map<string, number>> => { return app.check(z.number(), c); });`,
        `app.define({ check(v: unknown): Array<unknown> { return [z.boolean(), v]; } });`,
        `app.define({ check(v: unknown): unknown[] { return [z.bigint(), v]; } });`,
        `app.define({ check(v: unknown): { ok: boolean } { return app.check(z.date(), v); } });`,
      ]),
    ).toEqual([]);
  });

  it("a parameter's default value, whatever the function's return type", () => {
    expect(
      reported([
        `app.post("/x", (schema = z.string()) => schema);`,
        `app.post("/y", (schema = z.number()): unknown => schema);`,
        `app.post("/z", (schema = z.boolean()): unknown[] => [schema]);`,
        `app.post("/w", (schema = z.bigint()): Map<string, unknown> => new Map([["s", schema]]));`,
        `app.post("/v", (schema = z.date()): { s: unknown } => ({ s: schema }));`,
        `app.define({ make(schema = z.symbol()) { return schema; } });`,
        `app.define({ make(schema = z.null()): unknown { return schema; } });`,
      ]),
    ).toEqual([]);
  });

  it("but an object literal that follows a conditional's colon is still a literal", () => {
    // `f(a) : {` is also how a return type starts. Nothing ends the "type"
    // before the brace, so it is read as what it is.
    expect(
      reported([`app.use(app.flag ? app.make(1) : { body: z.string() }, z.number());`]),
    ).toEqual([`z.string()`, `z.number()`]);
  });

  it("a chain further into a concise arrow body than its first token", () => {
    expect(
      reported([
        `export const make = (strict: boolean) => strict && t.procedure.input(z.object({ a: z.string() }));`,
      ]),
    ).toEqual([]);
  });

  it("a schema built, used once and dropped", () => {
    expect(
      reported([
        `app.seed(z.object({ a: z.string() }).parse(app.defaults));`,
        `app.seed(z.parse(z.object({ b: z.string() }), app.defaults));`,
      ]),
    ).toEqual([]);
  });
});

describe("analyzeZodSchemas() — not a part of another schema", () => {
  it("the arguments of a derivation from an imported schema", () => {
    expect(reported([`export const Ext = Base.extend({ name: z.string() });`])).toEqual([]);
    expect(reported([`app.post("/x", Base.merge(z.object({ a: z.string() })));`])).toEqual([]);
  });

  it("the arguments of a derivation from a schema held in a module binding", () => {
    expect(
      reported([
        `const Local = z.object({ id: z.number() });`,
        `app.post("/x", zValidator("json", Local.extend({ name: z.string() })));`,
      ]),
    ).toEqual([]);
  });

  it("but the arguments of validating WITH one are whole schemas", () => {
    expect(
      reported([
        `const Local = z.object({ id: z.number() });`,
        `app.seed(Local.parse(app.through(z.object({ a: z.string() }))));`,
      ]),
    ).toEqual([`z.object({ a: z.string() })`]);
  });

  it("the arguments of a chain named like a schema", () => {
    expect(
      reported(
        [`export const Patch = UserZodSchema.partial().and(z.object({ a: z.string() }));`],
        [ZOD_IMPORT, `import { UserZodSchema } from "./schemas";`].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a prefix of a longer chain acorn cannot read to its end", () => {
    // `z.string()` parses, the generic call after it does not: a validator
    // there would be for a schema nothing ever validates with.
    expect(
      reported([
        `app.post("/x", zValidator("json", z.string().transform<number>((v) => v.length)));`,
        `app.post("/y", app.shape(z.object({ a: z.string() }).shape));`,
      ]),
    ).toEqual([]);
  });

  it("a class of zod's being constructed", () => {
    expect(reported([`app.use(new z.ZodError([]));`])).toEqual([]);
  });
});

describe("analyzeZodSchemas() — a private binding something uses", () => {
  it("validated with by a function", () => {
    expect(
      bindings([
        `const Body = z.object({ id: z.number() });`,
        `export function handler(input: unknown) { return Body.parse(input); }`,
      ]),
    ).toEqual(["Body"]);
  });

  it("whichever of the two comes first in the file", () => {
    expect(
      bindings([
        `export function handler(input: unknown) { return Body.safeParse(input); }`,
        `const Body = z.object({ id: z.number() });`,
      ]),
    ).toEqual(["Body"]);
  });

  it("passed on, returned, spread or put in a table", () => {
    expect(
      bindings([
        `const A = z.string();`,
        `const B = z.number();`,
        `const C = z.boolean();`,
        `const D = z.object({ d: z.string() });`,
        `app.post("/a", zValidator("json", A));`,
        `export function b() { return B; }`,
        `export const table = { C };`,
        `export const copy = { ...D };`,
      ]),
    ).toEqual(["A", "B", "C", "D"]);
  });

  it("with a type annotation, a TypeScript assertion or a comment after it", () => {
    expect(
      bindings([
        `const A: z.ZodType<string> = z.string();`,
        `const B = z.number() satisfies z.ZodType<number>;`,
        `const C = z.boolean() as z.ZodBoolean;`,
        `const D = z.bigint() // no semicolon here`,
        `export const use = (v: unknown) => [A.parse(v), B.parse(v), C.parse(v), D.parse(v)];`,
      ]),
    ).toEqual(["A", "B", "C", "D"]);
  });

  it("spelled over several lines", () => {
    expect(
      bindings([
        `const Body =`,
        `  z`,
        `    .object({ id: z.number() })`,
        `    .strict();`,
        `export const handler = (input: unknown) => Body.parse(input);`,
      ]),
    ).toEqual(["Body"]);
  });

  it("validated with through zod's own parse functions, the form zod/mini is written in", () => {
    expect(
      bindings(
        [
          `const Body = z.object({ id: z.number() });`,
          `const Other = z.string();`,
          `export const check = (v: unknown) => z.safeParse(Body, v).success;`,
          // Inside another schema on the way there, it is a part of that schema.
          `export const many = (v: unknown) => z.parse(z.array(Other), v);`,
        ],
        `import * as z from "zod/mini";`,
      ),
    ).toEqual(["Body"]);
  });

  it("names the declarations that take it into their initializer", () => {
    const [body] = analyze([
      `const Body = z.object({ id: z.number() });`,
      `export const BodySchema = Body;`,
      `export const validate = app.compile(Body);`,
      `export const Wider = Body.extend({ name: z.string() });`,
      `export const check = (v: unknown) => Body.safeParse(v);`,
    ]);
    // Either of the first two may be the same object under another name.
    // `Wider` is built FROM it and `check` only validates with it.
    expect(body?.within).toEqual(["BodySchema", "validate"]);
  });
});

describe("analyzeZodSchemas() — not a binding nothing uses for itself", () => {
  it("one that only other schemas are built from", () => {
    expect(
      bindings([
        `const Base2 = z.object({ id: z.number() });`,
        `const Tag = z.string().min(1);`,
        `export const Ext = Base2.extend({ name: z.string() });`,
        `export const Tagged = z.object({ tags: z.array(Tag), base: Base2 });`,
        `export const Loose = Base2.partial();`,
        `export const Shape = z.object({ ...Base2.shape });`,
        `export const Described = Tag.describe("a tag");`,
      ]),
    ).toEqual([]);
  });

  it("one that is only mentioned: in a type, as a key, as a property", () => {
    expect(
      bindings([
        `const Body = z.object({ id: z.number() });`,
        `export type Body = z.infer<typeof Body>;`,
        `export const table = { Body: 1 };`,
        `export const other = app.Body;`,
      ]),
    ).toEqual([]);
  });

  it("one nothing mentions at all", () => {
    expect(bindings([`const Body = z.object({ id: z.number() });`])).toEqual([]);
  });

  it("an exported one, which discovery compiles", () => {
    expect(
      bindings([
        `export const Body = z.object({ id: z.number() });`,
        `export function handler(input: unknown) { return Body.parse(input); }`,
      ]),
    ).toEqual([]);
  });

  it("one that is not the schema: a member of it, a fallback, a parse result, a let", () => {
    expect(
      bindings([
        `const shape = z.object({ id: z.number() }).shape;`,
        `const either = z.string() ?? app.fallback;`,
        `const parsed = z.boolean().parse(true);`,
        `let later = z.number();`,
        `const first = z.bigint(), second = z.date();`,
        `export const use = (v: unknown) => [shape, either.parse(v), parsed, later.parse(v), second.parse(v)];`,
      ]),
    ).toEqual([]);
  });

  it("one declared somewhere other than module scope", () => {
    expect(
      bindings([
        `if (app.flag) { const Inner = z.string(); app.use(Inner.parse("x")); }`,
        `export function f(v: unknown) { const Local = z.number(); return Local.parse(v); }`,
        `export const g = (v: unknown) => { const Local = z.boolean(); return Local.parse(v); };`,
      ]),
    ).toEqual([]);
  });
});

describe("analyzeZodSchemas() — whether a bag of methods could stand in for a binding", () => {
  function contained(lines: string[]): boolean | undefined {
    return analyze(lines).find((schema) => schema.name === "Body")?.contained;
  }
  const DECLARED = `const Body = z.object({ id: z.number() });`;

  it("can, when the file only ever validates with it", () => {
    expect(
      contained([
        DECLARED,
        `export type Body = z.infer<typeof Body>;`,
        `export const a = (v: unknown) => Body.parse(v);`,
        `export const b = (v: unknown) => Body.safeParse(v).success || Body.is(v);`,
        `export const c = async (v: unknown) => [await Body.parseAsync(v), await Body?.safeParseAsync(v)];`,
      ]),
    ).toBe(true);
  });

  it.each([
    ["handed on", `app.post("/x", zValidator("json", Body));`],
    ["exported under its own name", `export { Body };`],
    ["exported under another", `export const BodySchema = Body;`],
    ["returned", `export const get = () => Body;`],
    ["spread", `export const copy = { ...Body };`],
    ["built upon", `export const Wider = Body.extend({ name: z.string() });`],
    ["a member of another schema", `export const List = z.array(Body);`],
    ["read for something a bag has not got", `export const keys = Object.keys(Body.shape);`],
    ["decoded with", `export const d = (v: unknown) => Body.decode(v as never);`],
    ["indexed", `export const std = Body["~standard"];`],
    ["given to one of zod's parse functions", `export const f = (v: unknown) => z.parse(Body, v);`],
  ])("cannot, once it is %s", (_what, line) => {
    expect(contained([DECLARED, `export const a = (v: unknown) => Body.parse(v);`, line])).toBe(
      false,
    );
  });

  it("cannot, when the name is written anywhere the scanner does not read", () => {
    // A mention it cannot see is a use it cannot rule out: a comment or a
    // string here, but the same count is what catches JSX text and whatever
    // else a lexical scan is blind to.
    for (const unseen of [`// Body is validated below`, `export const label = "Body";`]) {
      expect(contained([DECLARED, unseen, `export const a = (v: unknown) => Body.parse(v);`])).toBe(
        false,
      );
    }
  });
});

describe("analyzeZodSchemas() — left exactly as written", () => {
  it("TypeScript inside the expression", () => {
    expect(
      reported([
        `app.post("/x", zValidator("json", z.custom<{ a: 1 }>(() => true)));`,
        `app.post("/y", zValidator("json", z.object({ a: z.string() as never })));`,
      ]),
    ).toEqual([]);
    expect(
      bindings([
        `const Body = z.object({ a: z.string() as never });`,
        `export const use = (v: unknown) => Body.parse(v);`,
      ]),
    ).toEqual([]);
  });

  it("an expression that reads `this` or awaits", () => {
    expect(
      reported([
        `app.post("/x", zValidator("json", z.string().default(await app.load())));`,
        `app.post("/y", zValidator("json", z.string().refine(() => this === undefined)));`,
      ]),
    ).toEqual([]);
  });

  it("text that only reads like a schema", () => {
    expect(
      reported([
        `// app.post("/x", zValidator("json", z.object({ id: z.number() })));`,
        `app.note("z.object({ id: z.number() })", ` + "`z.string() and ${1}`" + `, /z.number()/);`,
        // After `${`, a slash opens a regex: the text that follows the
        // literal is text, and the argument after that is an argument.
        "app.note(`${/[/]/.source}`, `z.boolean() is ${2}`, z.bigint());",
      ]),
    ).toEqual([`z.bigint()`]);
  });
});

describe("analyzeZodSchemas() — what is asked for", () => {
  const code = [
    IMPORTS,
    `const Body = z.object({ id: z.number() });`,
    `export const create = t.procedure.input(z.string()).query(() => Body.parse(1));`,
    `export function f() { return z.object({ a: z.string() }); }`,
  ].join("\n");

  it("reports nothing at module scope unless `moduleScope` is set", () => {
    expect(analyzeZodSchemas(code).moduleScope).toEqual([]);
    expect(analyzeZodSchemas(code, { moduleScope: true }).moduleScope).toHaveLength(2);
  });

  it("finds them with hoisting switched off, and leaves functions alone then", () => {
    const analysis = analyzeZodSchemas(code, { hoist: false, moduleScope: true });
    expect(analysis.hoist).toBeNull();
    expect(analysis.moduleScope.map((schema) => schema.text)).toEqual([
      `z.object({ id: z.number() })`,
      `z.string()`,
    ]);
  });

  it("does both in one pass when both are asked for", () => {
    const analysis = analyzeZodSchemas(code, { moduleScope: true });
    expect(analysis.hoist?.schemas.map((schema) => schema.text)).toEqual([
      `z.object({ a: z.string() })`,
    ]);
    expect(analysis.moduleScope).toHaveLength(2);
  });

  it("moves nothing that hoisting never moved", () => {
    // The hoist itself is what it was: module-scope chains stay where they are.
    const moduleOnly = code.split("\n").slice(0, -1).join("\n");
    expect(hoistZodSchemas(moduleOnly)).toBeNull();
    expect(analyzeZodSchemas(moduleOnly, { moduleScope: true }).hoist).toBeNull();
  });
});
