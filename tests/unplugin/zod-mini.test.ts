import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { loadSourceFile } from "#src/loader.js";
import { transformCode } from "#src/unplugin/transform.js";

/**
 * The build plugin on `zod/mini` modules, end to end (issue #22).
 *
 * Each module runs twice, as written and after the full transform (inline mode,
 * so the output runs without a bundler), and `run()` must agree, including on
 * the error class a failed parse hands back. A compiled Mini schema used to
 * fail with classic's `ZodError` where the schema itself fails with core's
 * `$ZodError`: same issues, different `name`, traits and methods. Lean output
 * cannot run without a bundler, so its helper import is checked instead.
 */

// Inside the repo tree so bare `zod` / `zod-compiler` imports resolve for both
// discovery (which executes the file at `id`) and the runs themselves.
const TMP_ROOT = mkdtempSync(path.join(import.meta.dirname, "..", "fixtures", ".mini-"));

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** What a consumer can observe about a parse result, error class included. */
const REPORT = `
function report(result: { success: boolean; data?: unknown; error?: any }) {
  if (result.success) return { success: true, data: result.data };
  const error = result.error;
  return {
    success: false,
    name: error.name,
    traits: [...error._zod.traits].sort(),
    classic: error instanceof ZodError,
    flatten: typeof error.flatten,
    issues: error.issues.map((i: any) => ({ code: i.code, path: i.path, message: i.message })),
  };
}
function thrown(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return report({ success: false, error });
  }
  return "did not throw";
}
`;

interface Fixture {
  name: string;
  source: string;
  autoDiscover: boolean;
  /** Whether a classic schema is compiled too, so classic finalizers must ship. */
  classic: boolean;
  /** Whether a function-local schema is hoisted AND compiled (hoist-compile path). */
  hoisted: boolean;
}

const FIXTURES: Fixture[] = [
  {
    name: "explicit compile() of a Mini schema (the issue's own case)",
    autoDiscover: false,
    classic: false,
    hoisted: false,
    source: `
import * as z from "zod/mini";
import { ZodError } from "zod";
import { compile } from "zod-compiler";
${REPORT}
export const User = compile(z.object({ name: z.string().check(z.minLength(2)), age: z.number() }));

export function run() {
  return {
    bad: report(User.safeParse({ name: "A", age: "1" })),
    good: report(User.safeParse({ name: "Ada", age: 36 })),
    parse: thrown(() => User.parse({})),
    is: [User.is({ name: "Ada", age: 36 }), User.is({})],
  };
}
`,
  },
  {
    name: "auto-discovered Mini exports and a hoisted function-local schema",
    autoDiscover: true,
    classic: false,
    hoisted: true,
    source: `
import * as z from "zod/mini";
import { ZodError } from "zod";
${REPORT}
export const Item = z.object({ id: z.string(), qty: z.int().check(z.positive()) });

function querySchema() {
  return z.object({ q: z.string().check(z.minLength(1)), page: z._default(z.number(), 1) });
}

export function run() {
  return {
    item: report(Item.safeParse({ id: 1, qty: 0 })),
    query: report(querySchema().safeParse({ q: "" })),
    defaulted: report(querySchema().safeParse({ q: "x" })),
  };
}
`,
  },
  {
    name: "hoisted Mini schemas in a module that exports none",
    autoDiscover: true,
    classic: false,
    hoisted: true,
    source: `
import * as z from "zod/mini";
import { ZodError } from "zod";
${REPORT}
function check(value: unknown) {
  return z.object({ email: z.email(), tags: z.array(z.string()) }).safeParse(value);
}

export function run() {
  return [report(check({ email: "nope", tags: [1] })), report(check({ email: "a@b.co", tags: [] }))];
}
`,
  },
  {
    name: "classic and Mini exports in one module keep their own classes",
    autoDiscover: true,
    classic: true,
    hoisted: false,
    source: `
import * as zm from "zod/mini";
import { z, ZodError } from "zod";
${REPORT}
export const MiniSchema = zm.object({ id: zm.string(), n: zm.number() });
export const ClassicSchema = z.object({ id: z.string(), n: z.number() });
export const MiniHoldingClassic = zm.object({ inner: z.object({ id: z.string() }) });

export function run() {
  return {
    mini: report(MiniSchema.safeParse({ id: 1 })),
    classic: report(ClassicSchema.safeParse({ id: 1 })),
    nested: report(MiniHoldingClassic.safeParse({ inner: {} })),
  };
}
`,
  },
];

describe("zod/mini through the build plugin", () => {
  let n = 0;
  for (const fixture of FIXTURES) {
    const dir = path.join(TMP_ROOT, `f${n++}`);

    it(`runs the same once transformed: ${fixture.name}`, async () => {
      mkdirSync(dir, { recursive: true });
      const origPath = path.join(dir, "orig.ts");
      writeFileSync(origPath, fixture.source);

      const transformed = await transformCode(fixture.source, origPath, {
        mode: "inline",
        autoDiscover: fixture.autoDiscover,
      });
      expect(transformed).not.toBeNull();
      const out = transformed ?? "";
      expect(out).toContain("__zcMkv(");
      // A hoisted schema left uncompiled would still run identically, so the
      // comparison below cannot tell; its declaration must hold a validator.
      expect(/const _zh_\w+ = \/\* @__PURE__ \*\/ \(\(\) => \{/.test(out), "compiled hoist").toBe(
        fixture.hoisted,
      );
      // Mini validators finalize through the core twins. The classic class and
      // a classic finalizer ship only where a classic schema is compiled too.
      expect(out).toMatch(/__zcFinD?C\(/);
      expect(out.includes("var __ZcFail="), "classic __ZcFail").toBe(fixture.classic);
      expect(/function __zcFinD?\(/.test(out), "classic finalizer").toBe(fixture.classic);

      const expected = ((await loadSourceFile(origPath))["run"] as () => unknown)();
      const outPath = path.join(dir, "out.ts");
      writeFileSync(outPath, out);
      const actual = ((await loadSourceFile(outPath))["run"] as () => unknown)();
      expect(actual).toEqual(expected);
    });

    it(`imports only the finalizers it calls in lean mode: ${fixture.name}`, async () => {
      mkdirSync(dir, { recursive: true });
      const id = path.join(dir, "lean.ts");
      writeFileSync(id, fixture.source);

      const transformed = await transformCode(fixture.source, id, {
        mode: "lean",
        autoDiscover: fixture.autoDiscover,
      });
      const imported = /import \{ ([^}]+) \} from "virtual:zod-compiler\/runtime"/.exec(
        transformed ?? "",
      )?.[1];
      expect(imported, "runtime import").toBeDefined();
      const names = new Set(imported?.split(", "));
      expect(names.has("__zcFinC") || names.has("__zcFinDC")).toBe(true);
      // The classic __zcFin used to be imported unconditionally; a module of
      // Mini schemas calls neither classic finalizer.
      if (!fixture.classic) {
        expect([...names].filter((h) => h === "__zcFin" || h === "__zcFinD")).toEqual([]);
      }
    });
  }
});
