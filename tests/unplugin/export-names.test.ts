/**
 * Export names past `\w`: a `$` (`$Schema`), letters outside ASCII (`Schéma`,
 * `日本`), characters past the BMP (`𝒳`).
 *
 * The validator generated for an export is named after it, and what found that
 * name again — the IIFE reading it back off the generated function, the rewrite
 * matching `<name> = compile(`, the check for a schema that mentions its own
 * name — was written with `\w` and `\b`. A `$` or an `é` in any export made the
 * transform throw, failing the build of the whole file; and a recursive `$Node`
 * that got past the throw would have read its own binding before it was
 * assigned. (The CLI's side is in tests/cli/emitter.test.ts, the name itself
 * in tests/core/iife.test.ts.)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { loadSourceFile } from "#src/loader.js";
import { transformCode } from "#src/unplugin/transform.js";
import type { TransformOptions } from "#src/unplugin/types.js";
import { expectParses } from "../expect-parses.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Inside the repo tree, so that `zod` and `zod-compiler` resolve both for
// discovery (which executes the file) and for executing the output.
const ROOT = mkdtempSync(path.join(__dirname, "..", "fixtures", ".export-names-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let serial = 0;
function write(source: string): string {
  const directory = path.join(ROOT, `m${serial++}`);
  mkdirSync(directory);
  const file = path.join(directory, "mod.ts");
  writeFileSync(file, source);
  return file;
}

/** What a parse comes to, in a shape two runs of a module can be compared by. */
const REPORT = `
function report(schema: { safeParse(v: unknown): any }, value: unknown) {
  const result = schema.safeParse(value);
  return result.success
    ? { data: result.data }
    : { issues: result.error.issues.map((i: any) => [i.code, i.path.join(".")]) };
}
`;

/** A compiled validator answers `.is()`; a plain Zod schema has no such method. */
function isCompiled(schema: unknown): boolean {
  return typeof (schema as { is?: unknown }).is === "function";
}

/**
 * Transform a module (inline helpers, so the output runs as it is), execute it
 * as written and as transformed, and hold `run()` to the same answer.
 */
async function executeBoth(
  source: string,
  options: Partial<TransformOptions> = {},
): Promise<{ out: string; compiled: Record<string, unknown> }> {
  const file = write(source);
  const out = await transformCode(source, file, { mode: "inline", autoDiscover: true, ...options });
  expect(out).not.toBeNull();
  expectParses(out as string);
  const outFile = path.join(path.dirname(file), "out.ts");
  writeFileSync(outFile, out as string);
  const original = await loadSourceFile(file);
  const compiled = await loadSourceFile(outFile);
  expect((compiled["run"] as () => unknown)()).toEqual((original["run"] as () => unknown)());
  return { out: out as string, compiled };
}

const EXPORTS = `import { z } from "zod";
export const $Schema = z.object({ a: z.string() });
export const Schéma = z.object({ a: z.string().min(2) });
export const $ = z.number().int();
export const a$ = z.boolean();
export const 日本 = z.string().max(3);
export const 𝒳 = z.array(z.number());
${REPORT}
export function run() {
  return [
    report($Schema, { a: "x" }),
    report($Schema, { a: 1 }),
    report(Schéma, { a: "x" }),
    report($, 1.5),
    report(a$, true),
    report(日本, "abcd"),
    report(𝒳, [1, "x"]),
  ];
}
`;
const EXPORT_NAMES = ["$Schema", "Schéma", "$", "a$", "日本", "𝒳"];

describe("an export named with a `$` or a letter outside ASCII", () => {
  it("is compiled, and validates as zod does", async () => {
    const { out, compiled } = await executeBoth(EXPORTS);
    for (const name of EXPORT_NAMES) {
      expect(out).toContain(`function safeParse_${name}(input)`);
      expect(isCompiled(compiled[name]), name).toBe(true);
    }
  });

  it("is compiled in lean mode", async () => {
    const file = write(EXPORTS);
    const out = await transformCode(EXPORTS, file, { mode: "lean", autoDiscover: true });
    expectParses(out as string);
    for (const name of EXPORT_NAMES) expect(out).toContain(`function safeParse_${name}(input)`);
  });

  it("finds its own name in a recursive schema, which keeps its declaration whole", async () => {
    // The `z.custom` is retained, and the IIFE reads it off the schema as it
    // starts: as the declaration's initializer, that read fires the getter,
    // which reads the binding it is still initializing.
    const source = `import { z } from "zod";
export const $Category: z.ZodType = z.object({
  name: z.custom<string>((v) => typeof v === "string"),
  get children() {
    return z.array($Category);
  },
});
export const Catégorie: z.ZodType = z.object({
  name: z.custom<string>((v) => typeof v === "string"),
  get children() {
    return z.array(Catégorie);
  },
});
export const Lazy$: z.ZodType = z.lazy(() =>
  z.union([z.custom<string>((v) => typeof v === "string"), z.array(Lazy$)]),
);
${REPORT}
export function run() {
  const tree = { name: "a", children: [{ name: "b", children: [] }] };
  const bad = { name: "a", children: [{ name: 2, children: [] }] };
  return [
    report($Category, tree),
    report($Category, bad),
    report(Catégorie, tree),
    report(Catégorie, bad),
    report(Lazy$, ["a", ["b"]]),
    report(Lazy$, ["a", [1]]),
  ];
}
`;
    const { out, compiled } = await executeBoth(source);
    for (const name of ["$Category", "Catégorie", "Lazy$"]) {
      // Its own expression still initializes it; the validator is installed
      // by the statement that follows.
      expect(out).toContain(`export const ${name}: z.ZodType = z.`);
      expect(isCompiled(compiled[name]), name).toBe(true);
    }
  });

  it("assigned a compile() call, is rewritten there, and a longer name is not taken for it", async () => {
    // `$User` comes first: a pattern for `User` that sees an edge at the `$`
    // rewrote that call with `User`'s validator.
    const source = `import { z } from "zod";
import { compile } from "zod-compiler";
export const $User = compile(z.object({ a: z.string() }));
export const Usuário = compile(z.object({ a: z.string().min(2) }));
export const User = compile(z.object({ b: z.number() }));
${REPORT}
export function run() {
  return [
    report($User, { a: 1 }),
    report($User, { a: "x" }),
    report(Usuário, { a: "x" }),
    report(User, { a: 1 }),
    report(User, { b: 1 }),
  ];
}
`;
    for (const autoDiscover of [true, false]) {
      const { out, compiled } = await executeBoth(source, { autoDiscover });
      expect(out).not.toMatch(/= compile\(/);
      expect(out).not.toContain(`import { compile }`);
      for (const name of ["$User", "Usuário", "User"]) {
        expect(out.split(`function safeParse_${name}(input)`)).toHaveLength(2);
        expect(isCompiled(compiled[name]), name).toBe(true);
      }
    }
  });
});
