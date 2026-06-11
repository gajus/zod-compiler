import { describe, expect, it } from "vitest";
import { hoistZodSchemas } from "#src/unplugin/hoist.js";

/**
 * Regression suite for the production `ReferenceError: <name> is not defined`
 * class: a hoist must never reference a name that is bound below it. Each
 * "stays put" case was (or could be) a binding the lexical collector missed;
 * the policy layer (imports + KNOWN_GLOBALS only) backstops anything the
 * collector cannot see.
 */

const ZOD_IMPORT = `import { z } from "zod";`;

describe("binding collection — expressions referencing file bindings stay put", () => {
  it("multiline object destructuring declarations", () => {
    const code = [
      ZOD_IMPORT,
      `declare function getSchemas(): any;`,
      `export function makeRoute() {`,
      `  const {`,
      `    inputSchema,`,
      `    outputSchema,`,
      `  } = getSchemas();`,
      `  return z.object({ in: inputSchema, out: outputSchema });`,
      `}`,
    ].join("\n");
    expect(hoistZodSchemas(code)).toBeNull();
  });

  it("multiline array destructuring declarations", () => {
    const code = [
      ZOD_IMPORT,
      `export function make(pair: unknown[]) {`,
      `  const [`,
      `    inputSchema,`,
      `  ] = pair;`,
      `  return z.object({ a: inputSchema });`,
      `}`,
    ].join("\n");
    expect(hoistZodSchemas(code)).toBeNull();
  });

  it("multiline let declarations", () => {
    const code = [
      ZOD_IMPORT,
      `export function f() {`,
      `  let`,
      `    inputSchema = null;`,
      `  inputSchema = z.string();`,
      `  return z.object({ a: inputSchema });`,
      `}`,
    ].join("\n");
    const result = hoistZodSchemas(code);
    // z.string() in the assignment may hoist; the chain referencing
    // inputSchema must not.
    if (result !== null) {
      expect(result).not.toMatch(/const _zh_[0-9a-f]{8} = z\.object\(\{ a: inputSchema \}\);/);
    }
  });

  it("function parameters whose defaults contain calls", () => {
    const code = [
      ZOD_IMPORT,
      `export function makeRoute(inputSchema = z.string().array()) {`,
      `  return z.object({ in: inputSchema });`,
      `}`,
    ].join("\n");
    const result = hoistZodSchemas(code);
    expect(result).not.toBeNull();
    // The default expression itself hoists (module-scope construction is
    // deterministic); the body chain referencing the PARAM must not.
    expect(result).toMatch(/makeRoute\(inputSchema = _zh_[0-9a-f]{8}\)/);
    expect(result).not.toMatch(/= z\.object\(\{ in: inputSchema \}\);/);
    expect(result).toContain(`return z.object({ in: inputSchema });`);
  });

  it("arrow parameters whose defaults contain calls", () => {
    const code = [
      ZOD_IMPORT,
      `export const makeRoute = (inputSchema = z.string().array()) => {`,
      `  return z.object({ in: inputSchema });`,
      `};`,
    ].join("\n");
    const result = hoistZodSchemas(code);
    if (result !== null) {
      expect(result).toContain(`return z.object({ in: inputSchema });`);
    }
  });

  it("multiline function parameter lists", () => {
    const code = [
      ZOD_IMPORT,
      `export function makeRoute(`,
      `  inputSchema: unknown,`,
      `  other: number,`,
      `) {`,
      `  return z.object({ in: inputSchema });`,
      `}`,
    ].join("\n");
    expect(hoistZodSchemas(code)).toBeNull();
  });

  it("class declaration names (TDZ)", () => {
    const code = [
      ZOD_IMPORT,
      `export function make() {`,
      `  return z.object({ r: Registry });`,
      `}`,
      `class Registry {}`,
    ].join("\n");
    expect(hoistZodSchemas(code)).toBeNull();
  });

  it("class names referenced from deferred callbacks (TDZ at parse time)", () => {
    const code = [
      ZOD_IMPORT,
      `export function make() {`,
      `  return z.custom((v) => v instanceof Registry);`,
      `}`,
      `class Registry {}`,
    ].join("\n");
    expect(hoistZodSchemas(code)).toBeNull();
  });

  it("for-of loop bindings", () => {
    const code = [
      ZOD_IMPORT,
      `export function make(parts: unknown[]) {`,
      `  const out = [];`,
      `  for (const inputSchema of parts) {`,
      `    out.push(z.object({ a: inputSchema }));`,
      `  }`,
      `  return out;`,
      `}`,
    ].join("\n");
    expect(hoistZodSchemas(code)).toBeNull();
  });

  it("catch-clause bindings with destructuring", () => {
    const code = [
      ZOD_IMPORT,
      `export function make() {`,
      `  try {`,
      `    return null;`,
      `  } catch ({ inputSchema }) {`,
      `    return z.object({ a: inputSchema });`,
      `  }`,
      `}`,
    ].join("\n");
    expect(hoistZodSchemas(code)).toBeNull();
  });

  it("method parameters whose defaults contain calls", () => {
    const code = [
      ZOD_IMPORT,
      `export class Router {`,
      `  make(inputSchema = z.string().array()) {`,
      `    return z.object({ in: inputSchema });`,
      `  }`,
      `}`,
    ].join("\n");
    const result = hoistZodSchemas(code);
    if (result !== null) {
      expect(result).toContain(`return z.object({ in: inputSchema });`);
    }
  });
});

describe("policy — unknown bare names are never assumed to be globals", () => {
  it("rejects expressions referencing unknown eager identifiers", () => {
    const code = [ZOD_IMPORT, `export function f() { return z.object({ a: mystery }); }`].join(
      "\n",
    );
    expect(hoistZodSchemas(code)).toBeNull();
  });

  it("rejects expressions referencing unknown deferred identifiers", () => {
    const code = [
      ZOD_IMPORT,
      `export function f() { return z.string().refine((v) => mysteryCheck(v)); }`,
    ].join("\n");
    expect(hoistZodSchemas(code)).toBeNull();
  });

  it("allows recognized standard globals eagerly (babel-parity behaviors)", () => {
    const code = [ZOD_IMPORT, `export function f() { return z.date().default(new Date()); }`].join(
      "\n",
    );
    expect(hoistZodSchemas(code)).toMatch(/const _zh_[0-9a-f]{8} = z\.date\(\)/);
  });

  it("allows recognized standard globals in deferred callbacks", () => {
    const code = [
      ZOD_IMPORT,
      `export function f() { return z.string().refine((v) => Number.isFinite(parseFloat(v))); }`,
    ].join("\n");
    expect(hoistZodSchemas(code)).toMatch(/const _zh_[0-9a-f]{8} = z\.string\(\)/);
  });

  it("rejects globals that are shadowed anywhere in the file", () => {
    const code = [
      ZOD_IMPORT,
      `export function f() { return z.date().default(new Date()); }`,
      `function other(Date: unknown) { return Date; }`,
    ].join("\n");
    expect(hoistZodSchemas(code)).toBeNull();
  });
});
