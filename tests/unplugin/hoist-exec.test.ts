import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadSourceFile } from "#src/loader.js";
import { transformCode } from "#src/unplugin/transform.js";

/**
 * Execution-equivalence harness: every fixture is a production-shaped module
 * exporting `run()`. The module is executed BOTH untransformed and after the
 * full plugin transform (hoist + hoisted-schema compile + autoDiscover
 * rewrite, inline mode so output is runnable without a bundler), and the
 * `run()` results must deep-equal.
 *
 * This catches the entire "transform emitted broken or behavior-changing
 * code" class regardless of which analysis gap caused it — a hoisted
 * expression referencing a not-yet-initialized binding crashes the
 * transformed run with the exact `ReferenceError: <name> is not defined`
 * seen in production.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Inside the repo tree so bare `import { z } from "zod"` resolves for both
// discovery (which executes the file at `id`) and the execution itself.
const TMP_ROOT = mkdtempSync(path.join(__dirname, "..", "fixtures", ".exec-"));

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

interface Fixture {
  name: string;
  source: string;
  /** Assert the transform produced (or deliberately skipped) optimizations. */
  expectTransformed?: boolean;
}

const FIXTURES: Fixture[] = [
  {
    name: "trpc-style router factory with local inputSchema",
    source: `
import { z } from "zod";

const t = {
  procedure: {
    input: (schema: { safeParse: (v: unknown) => unknown }) => ({
      query: (fn: (v: unknown) => unknown) => ({ schema, fn }),
    }),
  },
};

export function createRoute() {
  const inputSchema = z.object({ id: z.string().min(1), limit: z.number().int().positive() });
  return t.procedure.input(inputSchema).query((v) => v);
}

export function run() {
  const route = createRoute() as { schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { code: string }[] } } } };
  const ok = route.schema.safeParse({ id: "a", limit: 5 });
  const bad = route.schema.safeParse({ id: "", limit: -1 });
  return {
    ok: ok.success,
    bad: bad.success,
    codes: bad.success ? [] : bad.error?.issues.map((i) => i.code).sort(),
  };
}
`,
    expectTransformed: true,
  },
  {
    name: "multiline destructured schemas from a helper (must stay put)",
    source: `
import { z } from "zod";

function getSchemas() {
  return {
    inputSchema: z.string().min(2),
    outputSchema: z.number(),
  };
}

export function makeEnvelope() {
  const {
    inputSchema,
    outputSchema,
  } = getSchemas();
  return z.object({ in: inputSchema, out: outputSchema });
}

export function run() {
  const env = makeEnvelope();
  return {
    ok: env.safeParse({ in: "ab", out: 1 }).success,
    bad: env.safeParse({ in: "a", out: "x" }).success,
  };
}
`,
  },
  {
    name: "slonik-style sql.type with multiline schema and trailing comma",
    source: `
import { z } from "zod";

const sql = { type: (s: unknown) => (_q: TemplateStringsArray, ..._v: unknown[]) => s };
const pool = { one: (x: unknown) => x };

export const getUser = (id: number) => {
  return pool.one(
    sql.type(
      z.object({
        id: z.number(),
        name: z.string(),
      }),
    )\`SELECT id, name FROM users WHERE id = \${id}\`,
  );
};

export function run() {
  const schema = getUser(1) as { safeParse: (v: unknown) => { success: boolean; error?: { issues: { code: string; path: unknown[] }[] } } };
  const ok = schema.safeParse({ id: 1, name: "n" });
  const bad = schema.safeParse({ id: "1", name: 2 });
  return {
    ok: ok.success,
    bad: bad.success,
    issues: bad.success ? [] : bad.error?.issues.map((i) => ({ code: i.code, path: i.path })),
  };
}
`,
    expectTransformed: true,
  },
  {
    name: "exported schema + in-function schema in one file",
    source: `
import { z } from "zod";

export const UserSchema = z.object({ name: z.string().min(1), age: z.number().int() });

export function makeTagSchema() {
  return z.array(z.string().min(1)).max(3);
}

export function run() {
  const tags = makeTagSchema();
  return {
    user_ok: UserSchema.safeParse({ name: "a", age: 3 }).success,
    user_bad: UserSchema.safeParse({ name: "", age: 1.5 }).success,
    tags_ok: tags.safeParse(["a", "b"]).success,
    tags_bad: tags.safeParse(["a", "", "c", "d"]).success,
  };
}
`,
    expectTransformed: true,
  },
  {
    name: "schema as parameter default",
    source: `
import { z } from "zod";

export function validate(value: unknown, schema = z.string().email()) {
  return (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(value).success;
}

export function run() {
  return {
    ok: validate("a@example.com"),
    bad: validate("nope"),
    custom: validate(5, z.number()),
  };
}
`,
  },
  {
    name: "eager Date default and deferred standard-global refine",
    source: `
import { z } from "zod";

export function makeSchemas() {
  return {
    stamped: z.object({ at: z.date().default(new Date()) }),
    finite: z.string().refine((v) => Number.isFinite(parseFloat(v))),
  };
}

export function run() {
  const { stamped, finite } = makeSchemas();
  const withDefault = stamped.safeParse({});
  return {
    defaulted: withDefault.success && (withDefault as { data: { at: unknown } }).data.at instanceof Date,
    fin_ok: finite.safeParse("12.5").success,
    fin_bad: finite.safeParse("abc").success,
  };
}
`,
  },
  {
    name: "for-of loop building schemas from loop bindings",
    source: `
import { z } from "zod";

export function makeUnions() {
  const out: unknown[] = [];
  for (const literalValue of ["a", "b"]) {
    out.push(z.object({ kind: z.literal(literalValue) }));
  }
  return out;
}

export function run() {
  const [a, b] = makeUnions() as { safeParse: (v: unknown) => { success: boolean } }[];
  return {
    a_ok: a?.safeParse({ kind: "a" }).success,
    a_bad: a?.safeParse({ kind: "b" }).success,
    b_ok: b?.safeParse({ kind: "b" }).success,
  };
}
`,
  },
  {
    name: "shadowed z in a sibling function",
    source: `
import { z } from "zod";

export function unrelated(z: { object: (s: unknown) => unknown }) {
  return z.object({});
}

export function makeSchema() {
  return z.object({ a: z.string() });
}

export function run() {
  const s = makeSchema();
  return { ok: s.safeParse({ a: "x" }).success, bad: s.safeParse({ a: 1 }).success };
}
`,
  },
  {
    name: "class methods with schemas and a TDZ class reference",
    source: `
import { z } from "zod";

export class Validators {
  user(strict = false) {
    return z.object({ name: z.string().min(strict ? 2 : 1) });
  }
  registryAware() {
    return z.custom((v) => v instanceof Registry);
  }
}

class Registry {}

export function run() {
  const v = new Validators();
  return {
    loose_ok: v.user().safeParse({ name: "a" }).success,
    reg_ok: v.registryAware().safeParse(new Registry()).success,
    reg_bad: v.registryAware().safeParse({}).success,
  };
}
`,
  },
  {
    name: "identical schemas in two functions (dedup)",
    source: `
import { z } from "zod";

export function a() {
  return z.object({ v: z.string() });
}
export function b() {
  return z.object({ v: z.string() });
}

export function run() {
  return {
    same: a() === b() || JSON.stringify(a().safeParse({ v: "x" })) === JSON.stringify(b().safeParse({ v: "x" })),
    a_ok: a().safeParse({ v: "x" }).success,
    b_bad: b().safeParse({ v: 1 }).success,
  };
}
`,
    expectTransformed: true,
  },
];

describe("execution equivalence — original vs transformed", () => {
  let n = 0;
  for (const fixture of FIXTURES) {
    const dir = path.join(TMP_ROOT, `f${n++}`);
    it(fixture.name, async () => {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dir, { recursive: true });
      const origPath = path.join(dir, "orig.ts");
      writeFileSync(origPath, fixture.source);

      const transformed = await transformCode(fixture.source, origPath, {
        mode: "inline",
        autoDiscover: true,
      });
      if (fixture.expectTransformed) {
        expect(transformed).not.toBeNull();
      }

      const origMod = await loadSourceFile(origPath);
      const origRun = origMod["run"] as () => unknown;
      const expected = origRun();

      if (transformed === null) {
        return; // nothing changed; original behavior is the behavior
      }

      const outPath = path.join(dir, "out.ts");
      writeFileSync(outPath, transformed);
      // Executing the transformed module surfaces ReferenceErrors from bad
      // hoists at import time — exactly the production failure mode.
      const outMod = await loadSourceFile(outPath);
      const outRun = outMod["run"] as () => unknown;
      expect(outRun()).toEqual(expected);
    });
  }
});
