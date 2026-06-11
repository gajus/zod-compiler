import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { afterAll, describe, expect, it } from "vitest";
import { transformCodeWithMap } from "#src/unplugin/transform.js";

/**
 * Sourcemap correctness: positions in TRANSFORMED output must trace back to
 * the right ORIGINAL lines. Without maps, prepended declarations (hoists,
 * runtime helpers) and expanded IIFEs shift every following line — a vitest
 * assertion was reported ~90 lines off in the field.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(path.join(__dirname, "..", "fixtures", ".sourcemap-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** 1-based line / 0-based column of the first occurrence of `token`. */
function positionOf(code: string, token: string): { line: number; column: number } {
  const at = code.indexOf(token);
  if (at === -1) throw new Error(`token not found: ${token}`);
  const before = code.slice(0, at);
  const line = before.split("\n").length;
  const column = at - (before.lastIndexOf("\n") + 1);
  return { line, column };
}

/** Trace an output token back through the map; returns the original line. */
function traceBack(
  output: string,
  map: ConstructorParameters<typeof TraceMap>[0],
  token: string,
): number | null {
  const pos = positionOf(output, token);
  const original = originalPositionFor(new TraceMap(map), pos);
  return original.line;
}

let n = 0;
function write(name: string, source: string): string {
  const dir = path.join(TMP, `f${n++}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, source);
  return file;
}

describe("transformCodeWithMap() sourcemaps", () => {
  it("maps user code below hoisted+compiled schemas to original lines", async () => {
    const source = [
      `import { z } from "zod";`, // L1
      `const sql = { type: (s: unknown) => s };`, // L2
      ``,
      `export const getRow = (id: number) => {`, // L4
      `  return sql.type(z.object({ id: z.number(), name: z.string() }));`, // L5
      `};`,
      ``,
      `export function unrelatedAfter() {`, // L8
      `  return "sentinel-after";`, // L9
      `}`,
    ].join("\n");
    const id = write("hoisted.ts", source);

    const out = await transformCodeWithMap(source, id, { mode: "inline", autoDiscover: true });
    expect(out).not.toBeNull();
    const { code, map } = out as { code: string; map: ConstructorParameters<typeof TraceMap>[0] };
    expect(map).not.toBeNull();
    // The transform really did shift lines (hoisted IIFE + runtime helpers).
    expect(positionOf(code, `"sentinel-after"`).line).toBeGreaterThan(9);

    expect(traceBack(code, map, `"sentinel-after"`)).toBe(9);
    expect(traceBack(code, map, "unrelatedAfter")).toBe(8);
    // The call site keeps its identity: sql.type(_zh_...) still lives on L5.
    expect(traceBack(code, map, "sql.type(")).toBe(5);
  });

  it("maps code below an expanded autoDiscover IIFE to original lines", async () => {
    const source = [
      `import { z } from "zod";`, // L1
      ``,
      `export const UserSchema = z.object({ name: z.string().min(1) });`, // L3
      ``,
      `export function checkUser(value: unknown) {`, // L5
      `  return UserSchema.safeParse(value).success;`, // L6
      `}`,
    ].join("\n");
    const id = write("exported.ts", source);

    const out = await transformCodeWithMap(source, id, { mode: "lean", autoDiscover: true });
    expect(out).not.toBeNull();
    const { code, map } = out as { code: string; map: ConstructorParameters<typeof TraceMap>[0] };
    expect(map).not.toBeNull();
    // IIFE expansion pushed the function far below its original line.
    expect(positionOf(code, "checkUser").line).toBeGreaterThan(5);

    expect(traceBack(code, map, "checkUser")).toBe(5);
    expect(traceBack(code, map, "UserSchema.safeParse")).toBe(6);
    // The rewritten declaration itself still maps to its original line.
    expect(traceBack(code, map, "export const UserSchema")).toBe(3);
  });

  it("returns null map only when nothing changed", async () => {
    const source = `export const plain = 1;\n`;
    const id = write("plain.ts", source);
    const out = await transformCodeWithMap(source, id, { mode: "lean", autoDiscover: true });
    expect(out).toBeNull();
  });

  it("sources reference the file id with original content embedded", async () => {
    const source = [
      `import { z } from "zod";`,
      `export function f() { return z.object({ a: z.string() }); }`,
    ].join("\n");
    const id = write("content.ts", source);
    const out = await transformCodeWithMap(source, id, { mode: "lean", autoDiscover: true });
    expect(out).not.toBeNull();
    const map = (out as { map: { sources: (string | null)[]; sourcesContent?: (string | null)[] } })
      .map;
    expect(map.sources).toContain(id);
    expect(map.sourcesContent?.[0]).toBe(source);
  });
});
