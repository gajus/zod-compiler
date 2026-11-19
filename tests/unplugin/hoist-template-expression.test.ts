import { describe, expect, it } from "vite-plus/test";
import { hoistZodSchemas } from "#src/unplugin/hoist.js";

/**
 * A `/` directly after `${` opens a regex. The scanner used to read it as a
 * division — it had just seen a template chunk, and after a template LITERAL a
 * slash does divide — and a regex that then failed to lex as arithmetic took
 * the scanner's place in the file with it: from the literal's closing backtick
 * on, code was read as template text and template text as code.
 *
 * Each case fails without `templateChunkToken`: the first two by rewriting the
 * contents of a string, the others by losing sight of the code that follows.
 */
describe("hoistZodSchemas() — a regex that opens a template expression", () => {
  const ZOD_IMPORT = `import { z } from "zod";`;
  // `[/]` is what derails a division reading: the `/` inside the class starts
  // a "regex" that swallows the class's own closing bracket.
  const OPENER = "const flag = `${/[/]/.test(value)}`;";

  it("leaves the text of a later template literal alone", () => {
    const code = [
      ZOD_IMPORT,
      `export function describeCheck(value: string) {`,
      `  ${OPENER}`,
      "  return `z.string().min(1) is how ${value} is checked (${flag})`;",
      `}`,
    ].join("\n");

    // There is no schema in this file, only a sentence about one.
    expect(hoistZodSchemas(code)).toBeNull();
  });

  it("leaves a later string alone when the expression is not the template's first", () => {
    const code = [
      ZOD_IMPORT,
      `export function describeCheck(value: string) {`,
      "  const flag = `${value}: ${/[/]/.test(value)}`;",
      "  return `z.number().int() is how ${value} is checked (${flag})`;",
      `}`,
    ].join("\n");

    expect(hoistZodSchemas(code)).toBeNull();
  });

  it("still hoists the schema that follows it in the same function", () => {
    const code = [
      ZOD_IMPORT,
      `export function check(value: string) {`,
      `  ${OPENER}`,
      `  return z.string().min(1).safeParse(flag);`,
      `}`,
    ].join("\n");

    const out = hoistZodSchemas(code) ?? "";
    expect(out).toMatch(/^const _zh_[0-9a-f]{8} = z\.string\(\)\.min\(1\);$/m);
    expect(out).toMatch(/return _zh_[0-9a-f]{8}\.safeParse\(flag\);/);
    expect(out).toContain(OPENER);
  });

  it.each([
    ["its first", "sql.fragment`SELECT ${/[/]/.source} AS pattern`"],
    ["a later", "sql.fragment`SELECT ${1} AS one, ${/[/]/.source} AS pattern`"],
  ])(
    "measures a module-scope chain whose template has it as %s expression, and hoists what follows",
    (_position, chain) => {
      // The chain's extent is found by a second scanner (findChainEnd); losing
      // its place there masked every candidate to the end of the file.
      const code = [
        ZOD_IMPORT,
        `import { sql } from "slonik";`,
        `export const slashes = ${chain};`,
        `export function getRow() {`,
        `  return sql.type(z.object({ id: z.number() }));`,
        `}`,
      ].join("\n");

      const out = hoistZodSchemas(code) ?? "";
      expect(out).toMatch(/^const _zh_[0-9a-f]{8} = z\.object\(\{ id: z\.number\(\) \}\);$/m);
      expect(out).toMatch(/return sql\.type\(_zh_[0-9a-f]{8}\);/);
      expect(out).toContain(`export const slashes = ${chain};`);
    },
  );

  it("still divides after a template literal", () => {
    // The other reading of a chunk's end, which has to survive: a literal is
    // an operand, and the slash after it is not the start of a regex running
    // to the next slash on the line.
    const code = [
      ZOD_IMPORT,
      `export function ratio(value: number) {`,
      "  const half = +`${value}` / 2; const s = z.number().max(half); // a/b",
      `  return s;`,
      `}`,
    ].join("\n");

    // `half` is a local, so nothing moves — but the schema was SEEN, which a
    // regex running from the first slash to the comment's would have hidden.
    expect(hoistZodSchemas(code)).toBeNull();
    const hoistable = code.replace("z.number().max(half)", "z.number().max(2)");
    expect(hoistZodSchemas(hoistable)).toMatch(/const _zh_[0-9a-f]{8} = z\.number\(\)\.max\(2\);/);
  });
});
