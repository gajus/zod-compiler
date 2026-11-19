/**
 * The module-scope scan, judged by a real parser.
 *
 * `analyzeZodSchemas()` decides lexically — no AST — which schema constructions
 * are evaluated once, at module scope, as a whole schema, and those are the ones
 * the transform compiles where they stand. It is allowed to MISS one (the schema
 * stays as written). It is not allowed to report one that is something else: a
 * construction inside a function body, a default parameter or a loop would get
 * its validator rebuilt on every evaluation; one that is a part of a larger
 * schema would get a validator nothing calls; an extent that is not an
 * expression at all would be rewritten into broken code.
 *
 * tests/unplugin/module-scope.test.ts pins the cases someone thought of. This
 * file checks the direction itself, with TypeScript's parser as the oracle: over
 * every source file in this repository (thousands of schemas, nearly all of them
 * inside test callbacks), and over seeded modules that nest a schema inside
 * random stacks of the constructs that decide the question.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";
import { analyzeZodSchemas, type ModuleScopeSchema } from "#src/unplugin/hoist.js";
import { rng } from "../structural-gen.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** zod's own functions that take a schema to validate WITH, not to build from. */
const PARSE_FUNCTIONS = new Set([
  "parse",
  "safeParse",
  "parseAsync",
  "safeParseAsync",
  "decode",
  "encode",
  "safeDecode",
  "safeEncode",
]);

function parse(file: string, code: string): ts.SourceFile {
  const kind = /\.[cm]?[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
}

/** Names the module binds to zod at runtime. */
function zodBindings(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!(specifier === "zod" || specifier.startsWith("zod/")) || !clause || clause.isTypeOnly) {
      continue;
    }
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) names.add(element.name.text);
      }
    }
  }
  return names;
}

/** The identifier a member/call chain starts at, or null when it starts at something else. */
function chainRoot(expression: ts.Expression): string | null {
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isTaggedTemplateExpression(current)) current = current.tag;
    else if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
    } else return null;
  }
}

/** The expression that occupies exactly `[start, end)`, if there is one. */
function expressionAt(source: ts.SourceFile, start: number, end: number): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null || node.getFullStart() > start || node.getEnd() < end) return;
    if (node.getStart(source) === start && node.getEnd() === end && ts.isExpression(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Why a reported construction should NOT have been reported, or null when the
 * report stands.
 */
function objection(
  source: ts.SourceFile,
  zod: ReadonlySet<string>,
  schema: Pick<ModuleScopeSchema, "start" | "end" | "name">,
): string | null {
  const node = expressionAt(source, schema.start, schema.end);
  if (node === null) return "its extent is not an expression";

  if (schema.name !== undefined) {
    const declaration = node.parent;
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) {
      return "a binding that is not an initializer";
    }
    if (!ts.isIdentifier(declaration.name) || declaration.name.text !== schema.name) {
      return "a binding under another name";
    }
    const list = declaration.parent;
    const statement = list.parent;
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) {
      return "a binding that is not a const";
    }
    if (!ts.isVariableStatement(statement) || statement.parent !== source) {
      return "a binding that is not at module scope";
    }
    if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      return "a binding that is exported";
    }
    return null;
  }

  let child: ts.Node = node;
  for (
    let ancestor = node.parent;
    ancestor !== source;
    child = ancestor, ancestor = ancestor.parent
  ) {
    if (ts.isFunctionLike(ancestor)) return `inside a ${ts.SyntaxKind[ancestor.kind]}`;
    if (
      ts.isPropertyDeclaration(ancestor) &&
      !ancestor.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
    ) {
      return "inside an instance property";
    }
    if (ts.isIterationStatement(ancestor, false)) return "inside a loop";
    if (ts.isCallExpression(ancestor) && ancestor.arguments.includes(child as ts.Expression)) {
      const callee = ancestor.expression;
      const root = chainRoot(callee);
      const validates =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        PARSE_FUNCTIONS.has(callee.name.text);
      if (root !== null && zod.has(root) && !validates) {
        return `a part of the schema ${callee.getText(source).slice(0, 40)} builds`;
      }
    }
  }
  return null;
}

function sourceFiles(directory: string, into: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(full, into);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) into.push(full);
  }
  return into;
}

describe("analyzeZodSchemas() — every module-scope report stands up to a parser", () => {
  it("across this repository's own sources", () => {
    const objections: string[] = [];
    let reported = 0;
    for (const file of sourceFiles(ROOT)) {
      const code = fs.readFileSync(file, "utf8");
      if (!/from\s+["']zod(?:\/[^"']*)?["']/.test(code)) continue;
      const schemas = analyzeZodSchemas(code, { moduleScope: true }).moduleScope;
      if (schemas.length === 0) continue;
      const source = parse(file, code);
      const zod = zodBindings(source);
      for (const schema of schemas) {
        reported++;
        const why = objection(source, zod, schema);
        if (why !== null) {
          const { line } = source.getLineAndCharacterOfPosition(schema.start);
          objections.push(`${path.relative(ROOT, file)}:${line + 1} ${why}: ${schema.text}`);
        }
      }
    }
    expect(objections).toStrictEqual([]);
    // The benchmark fixtures and a handful of tests build schemas at module scope.
    expect(reported).toBeGreaterThan(20);
  });
});

// ─── Seeded modules ──────────────────────────────────────────────────────────

const HEADER = [
  `import { z } from "zod";`,
  `import { app, Base, cond, foo, list, sql, t, Thing, xs } from "./stuff";`,
].join("\n");

/** An expression context: takes an expression, returns a larger one. */
type Wrap = (inner: string, r: () => number) => string;

/** Contexts that evaluate what they hold exactly when they are evaluated. */
const TRANSPARENT: Wrap[] = [
  (e) => `foo(${e})`,
  (e) => `app.use("/x", ${e})`,
  (e) => `t.router({ a: ${e}, b: 1 })`,
  (e) => `[${e}, 1]`,
  (e) => `({ key: ${e} })`,
  (e) => `new Thing(${e})`,
  (e) => `(cond ? ${e} : null)`,
  // (An arrow function cannot be a bare operand, so the operand is parenthesized.)
  (e) => `(cond && (${e}))`,
  (e) => `(${e})`,
  (e) => `[...list(${e})]`,
  (e) => `foo((${e}) as never)`,
  (e) => "sql`a ${foo(" + e + ")} b`",
  (e) => `foo("z.object({})", /z\\.string\\(\\)/.test("x"), ${e})`,
  (e) => `foo(/* z.string() */ ${e}, \`z.number() \${1}\`)`,
  (e) => `foo(\n  // z.boolean()\n  ${e},\n)`,
];

/** Contexts that evaluate what they hold later, repeatedly, or not as a value. */
const OPAQUE: Wrap[] = [
  (e) => `() => ${e}`,
  (e) => `(a: unknown) => { return ${e}; }`,
  (e) => `async (a: string): Promise<unknown> => ${e}`,
  (e) => `(a: number): { b: string } | null => { foo(${e}); return null; }`,
  (e) => `function () { return ${e}; }`,
  (e) => `function named(a = ${e}) { return a; }`,
  (e) => `(a = ${e}) => a`,
  (e) => `({ method() { return ${e}; } })`,
  (e) => `({ get value() { return ${e}; } })`,
  (e) => `({ async *items() { yield ${e}; } })`,
  (e) => `class { property = ${e}; }`,
  (e) => `class { method() { return ${e}; } }`,
  (e) => `foo(() => ${e})`,
  (e) => `foo(function () { return ${e}; })`,
];

/**
 * Chains at statement level that are not schemas, and are rooted at a member
 * access on an import — the roots the scan starts from. What is among their
 * arguments is what compiling in place is for.
 */
const CHAINS: Wrap[] = [
  (e) => `app.use("/x", ${e})`,
  (e) => `t.router({ a: ${e}, b: 1 })`,
  (e) => `t.procedure.input(${e}).query(() => 1)`,
  (e) => "sql.type(" + e + ")`SELECT 1`",
  (e) => `app.post("/x", foo(${e}), () => 1)`,
  (e) => `app.define({ body: ${e}, responses: [1] })`,
];

/** Contexts that make what they hold a PART of another schema. */
const BUILDING: Wrap[] = [
  (e) => `z.array(${e})`,
  (e) => `z.object({ member: ${e} })`,
  (e) => `z.union([${e}, z.null()])`,
  (e) => `(${e}).optional()`,
];

/** A statement around an expression that is not itself a schema. */
const STATEMENTS: ((expression: string, id: number) => string)[] = [
  (e, id) => `export const s${id} = ${e};`,
  (e, id) => `const p${id} = ${e};`,
  (e) => `foo(${e});`,
  (e, id) => `export const n${id} = ${e}`,
  (e) => `if (cond) {\n  foo(${e});\n}`,
  (e) => `for (const x of xs) {\n  foo(x, ${e});\n}`,
  (e) => `while (cond) foo(${e});`,
  (e, id) => `function f${id}() {\n  return ${e};\n}`,
  // A concise arrow body: the chain is at depth 0 and still runs per call.
  (e, id) => `export const make${id} = () => ${e};`,
  (e, id) => `export const choose${id} = (a: unknown) => cond && ${e};`,
  (e, id) => `const later${id} = async (a: string): Promise<unknown> => (a ? ${e} : null);`,
  (e, id) =>
    `export class C${id} {\n  static table = ${e};\n  own = ${e.replace(/\d+/g, (n) => `${n}0`)};\n}`,
];

interface Generated {
  code: string;
  /** How many schema markers the module holds. */
  markers: number;
}

function generate(seed: number): Generated {
  const r = rng(seed * 2_654_435);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(r() * values.length)] as T;
  let marker = 0;
  const statements: string[] = [];
  for (let count = 2 + Math.floor(r() * 4); count > 0; count--) {
    // A unique marker each time, so every construction can be told apart.
    let expression =
      r() < 0.5 ? `z.string().min(${++marker})` : `z.object({ n: z.literal(${++marker}) })`;
    for (let depth = 1 + Math.floor(r() * 4); depth > 0; depth--) {
      const roll = r();
      const wrap = roll < 0.55 ? pick(TRANSPARENT) : roll < 0.85 ? pick(OPAQUE) : pick(BUILDING);
      expression = wrap(expression, r);
    }
    // The outermost context is a chain that is not a schema's: a schema at
    // statement level is a binding or an export, which is another question.
    expression = pick(CHAINS)(expression, r);
    statements.push(pick(STATEMENTS)(expression, marker));
  }
  return { code: `${HEADER}\n${statements.join("\n")}\n`, markers: marker };
}

describe("analyzeZodSchemas() — seeded modules, judged the same way", () => {
  let reported = 0;
  let wholeAndOnce = 0;
  let found = 0;

  for (let seed = 1; seed <= 400; seed++) {
    it(`seed ${seed}`, () => {
      const { code } = generate(seed);
      const source = parse("generated.ts", code);
      // The generator has to produce code a parser accepts, or the oracle means nothing.
      expect(
        (source as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics,
        code,
      ).toHaveLength(0);
      const zod = zodBindings(source);
      const analysis = analyzeZodSchemas(code, { moduleScope: true });
      const schemas = analysis.moduleScope;
      for (const schema of schemas) {
        reported++;
        expect(objection(source, zod, schema), `${schema.text}\n\n${code}`).toBeNull();
      }
      // A construction the same scan HOISTS is compiled too, by that route.
      const hoisted = analysis.hoist?.edits ?? [];

      // How much of what COULD be compiled in place was found. Every outermost
      // zod construction the oracle has no objection to is one.
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && zod.has(chainRoot(node) ?? "")) {
          const outer = node.parent;
          const inChain =
            (ts.isPropertyAccessExpression(outer) || ts.isCallExpression(outer)) &&
            outer.expression === node;
          if (!inChain) {
            const extent = { start: node.getStart(source), end: node.getEnd() };
            if (objection(source, zod, extent) === null) {
              wholeAndOnce++;
              if (
                schemas.some((schema) => schema.start === extent.start) ||
                hoisted.some((edit) => edit.start <= extent.start && extent.end <= edit.end)
              ) {
                found++;
              }
            }
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    });
  }

  it("found most of what a parser says could be compiled in place", () => {
    // In place, or — for one the same scan hoists — by that route. What is left
    // are shapes the scan declines on purpose (a parenthesized chain, a schema
    // with a class among its members), and declining is always allowed.
    expect(reported).toBeGreaterThan(150);
    expect(found / wholeAndOnce).toBeGreaterThan(0.85);
  });
});
