/**
 * LEAN-MODE issue parity: the virtual runtime module EXECUTED, not inspected.
 *
 * Inline mode (the CLI emitter) writes each issue as an object literal at the
 * check site. Lean mode (every unplugin bundler) writes a CALL instead —
 * `__zcTS(min,origin,inclusive,input,path)` and friends — into
 * "virtual:zod-compiler/runtime". An issue's shape therefore lives in two
 * places, and the two can drift in three distinct ways:
 *
 *   1. MISSING EXPORT. A helper codegen names but the module does not declare
 *      is a build-breaking MISSING_EXPORT in every consumer bundle. This has
 *      shipped once already — `__zcUK` was added to ISSUE_DECLS (and so to the
 *      imports codegen emits) while buildRuntimeSource still enumerated decls
 *      by hand; see the file comment in src/unplugin/virtual.ts.
 *   2. ARITY DRIFT. The call convention is POSITIONAL and deliberately terse.
 *      A helper that gains or loses a parameter while its call sites stay put
 *      silently builds issues with fields shifted by one — no error anywhere.
 *   3. SHAPE DRIFT. A helper and the inline literal for the same issue can
 *      simply disagree about which keys they write.
 *
 * The suite has had static checks for (1) — names cross-referenced against
 * ALL_HELPER_NAMES in tests/unplugin/virtual.test.ts — but had never RUN a
 * lean-compiled validator against the module the plugin actually ships. So (2)
 * and (3) were invisible, and (1) was only ever checked by regex over source.
 *
 * Every case below compiles in lean mode through `compileLeanLikeProduction`,
 * whose helper bodies come from `loadVirtual(RESOLVED_RUNTIME_ID)` — the same
 * function the bundler plugins call, not a transcription — and compares the
 * resulting issues against zod's WHOLE issue objects (see expectParity's doc
 * comment for what "whole" covers). The spread is chosen to reach every entry
 * in ISSUE_DECLS and RUNTIME_HELPER_DECLS at least once; the registry
 * assertions at the bottom fail if a new helper appears and this file does not
 * exercise it.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import { ISSUE_DECLS, RUNTIME_HELPER_DECLS } from "#src/core/codegen/issue-decls.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { ALL_HELPER_NAMES, loadVirtual, RESOLVED_RUNTIME_ID } from "#src/unplugin/virtual.js";
import { expectLeanParity } from "./parity-harness.js";

const RUNTIME_SOURCE = loadVirtual(RESOLVED_RUNTIME_ID) ?? "";

/**
 * Every case in this file, as `[label, schema, inputs]`. Kept as one table so
 * the registry checks below can compile the exact same schemas and collect the
 * helpers they actually reference — a helper exercised by no case shows up
 * there as a coverage hole rather than passing unnoticed.
 */
const CASES: [label: string, schema: z.ZodType, inputs: unknown[]][] = [
  // ── too_small / too_big, all three forms ─────────────────────────────────
  // __zcTS: inclusive true (.min) and false (.gt), across origins.
  ["too_small string", z.string().min(3), ["ab"]],
  ["too_small exclusive", z.number().gt(3), [3]],
  ["too_small array", z.array(z.string()).min(2), [["a"]]],
  ["too_small set", z.set(z.string()).min(2), [new Set(["a"])]],
  ["too_small date", z.date().min(new Date(1_000)), [new Date(0)]],
  ["too_small bigint", z.bigint().min(3n), [1n]],
  ["too_small with message", z.string().min(3, "short!"), ["ab"]],
  // __zcTSx / __zcTBx: the exact form, which spells out inclusive AND exact.
  ["too_small exact", z.string().length(3), ["ab"]],
  ["too_big exact", z.string().length(3), ["abcd"]],
  ["too_big exact array", z.array(z.string()).length(2), [["a", "b", "c"]]],
  // __zcTSt: the tuple's under-length issue, whose `origin` trails `inclusive`.
  ["too_small tuple key order", z.tuple([z.string(), z.number()]), [["a"]]],
  ["too_small tuple with message", z.tuple([z.string()], undefined, "wrong arity"), [[]]],
  // __zcTBt: the tuple's OVER-length issue, whose `origin` trails `inclusive`.
  ["too_big tuple key order", z.tuple([z.string(), z.number()]), [["a", 1, 2]]],
  // __zcLo / __zcSo: a length/size check whose `when` fires on a value of the
  // WRONG type, so its `origin` has to be computed from the input at runtime.
  ["length check over a non-string", z.string().min(2), [[]]],
  ["length check over a short string", z.array(z.string()).min(3), ["ab"]],
  ["size check over a Map", z.set(z.string()).min(2), [new Map()]],
  ["size check over a Set", z.file().min(2), [new Set(["a"])]],
  // __zcTB: inclusive true (.max) and false (.lt).
  ["too_big string", z.string().max(2), ["abc"]],
  ["too_big exclusive", z.number().lt(3), [3]],
  ["too_big tuple", z.tuple([z.string()]), [["a", "b"]]],
  ["too_big with message", z.number().max(2, "too much"), [3]],

  // ── invalid_type ─────────────────────────────────────────────────────────
  ["invalid_type string", z.string(), [1]],
  ["invalid_type nested", z.object({ a: z.object({ b: z.number() }) }), [{ a: { b: "x" } }]],
  ["invalid_type with message", z.string("must be text"), [1]],
  ["invalid_type array element", z.array(z.boolean()), [[true, 1]]],

  // ── invalid_format: bare, with extra fields, and with a message ──────────
  ["invalid_format email", z.email(), ["nope"]],
  ["invalid_format uuid", z.uuid(), ["nope"]],
  ["invalid_format regex", z.string().regex(/^a+$/), ["b"]],
  // The ISO family resolves to bundle-wide `__zcReIso*` imports, and the two
  // that unroll also report through a `__zcReIso*Src` import — so these cover
  // the runtime module's regex exports AND its original-pattern strings.
  ["invalid_format iso.date", z.iso.date(), ["2020-13-01", "nope"]],
  ["invalid_format iso.time", z.iso.time(), ["24:00", "nope"]],
  ["invalid_format iso.datetime", z.iso.datetime(), ["2020-01-02T03:04:05", "nope"]],
  ["invalid_format iso.duration", z.iso.duration(), ["P", "nope"]],
  ["invalid_format starts_with", z.string().startsWith("ab"), ["xy"]],
  ["invalid_format includes", z.string().includes("ab"), ["xy"]],
  ["invalid_format lowercase", z.string().lowercase(), ["AB"]],
  ["invalid_format with message", z.email("bad address"), ["nope"]],

  // ── invalid_value, with and without the extra field ──────────────────────
  ["invalid_value enum", z.enum(["a", "b"]), ["c"]],
  ["invalid_value literal", z.literal("a"), ["b"]],
  ["invalid_value literal multi", z.literal(["a", 1, true]), ["b"]],
  // stringbool's codec also pushes `expected: "stringbool"` — the extra arg.
  ["invalid_value stringbool (extra)", z.stringbool(), ["maybe"]],
  ["invalid_value with message", z.enum(["a"], "pick one"), ["b"]],

  // ── unrecognized_keys ────────────────────────────────────────────────────
  ["unrecognized_keys", z.strictObject({ a: z.string() }), [{ a: "x", b: 1, c: 2 }]],
  [
    "unrecognized_keys with message",
    z.strictObject({ a: z.string() }, "no extras"),
    [{ a: "x", b: 1 }],
  ],

  // ── invalid_key / invalid_element wrappers (nested `issues`) ─────────────
  ["invalid_key record", z.record(z.email(), z.number()), [{ nope: 1 }]],
  ["invalid_key map", z.map(z.string().min(3), z.number()), [new Map([["a", 1]])]],
  ["invalid_element map", z.map(z.string(), z.number().min(3)), [new Map([["a", 1]])]],
  ["invalid_element set", z.set(z.string().min(3)), [new Set(["a"])]],

  // ── invalid_union (nested `errors`) ──────────────────────────────────────
  ["invalid_union scalars", z.union([z.string(), z.number()]), [true]],
  [
    "invalid_union objects",
    z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
    [{}],
  ],
  ["invalid_union nested", z.object({ u: z.union([z.string().min(3), z.number()]) }), [{ u: "a" }]],
  [
    "invalid_union discriminated",
    z.discriminatedUnion("t", [
      z.object({ t: z.literal("a"), v: z.string() }),
      z.object({ t: z.literal("b"), v: z.number() }),
    ]),
    [{ t: "c" }],
  ],
  // __zcITc: a discriminated union's non-object guard is the ONE invalid_type
  // in zod that writes `code` before `expected`.
  [
    "invalid_type discriminated union",
    z.discriminatedUnion("t", [z.object({ t: z.literal("a"), v: z.string() })]),
    [1],
  ],

  // ── custom (refine) and the non-issue runtime helpers ────────────────────
  // __zcFsr — float-safe remainder; __zcHop — record key guard;
  // __zcAb — abort gating; __zcSr / __zcSrOk — superRefine;
  // __zcCu — z.custom predicate; __zcPfx — map entry path prefixing.
  ["not_multiple_of float", z.number().multipleOf(0.1), [0.15]],
  ["record value", z.record(z.string(), z.number()), [{ a: "x" }]],
  // __zcPlain: a record's plain-object guard, which rejects a Date/Map/class
  // instance the way $ZodRecord's `util.isPlainObject` does.
  ["record non-plain input", z.record(z.string(), z.number()), [new Date(0), new Map()]],
  [
    "outer refine after inner failure",
    z.object({ a: z.string().min(3) }).refine(() => false),
    [{ a: "x" }],
  ],
  ["custom refine", z.string().refine((s) => s.length > 3, "too short"), ["a"]],
  ["custom refine with params", z.string().refine(() => false, { params: { tag: "t" } }), ["a"]],
  // A fast-path-eligible node routes its superRefine through __zcSrOk first
  // (the verdict-only probe); the string form above only ever reaches __zcSr.
  [
    "superRefine fast-eligible",
    z.number().superRefine((n, ctx) => {
      if (n < 3) ctx.addIssue({ code: "custom", input: n, message: "srf" });
    }),
    [1],
  ],
  [
    "superRefine",
    z.string().superRefine((s, ctx) => {
      if (s.length < 3) ctx.addIssue({ code: "custom", input: s, message: "sr" });
    }),
    ["a"],
  ],
  ["z.custom predicate", z.custom<string>((v) => typeof v === "string"), [1]],
  ["z.instanceof", z.instanceof(Date), [1]],

  // ── mixed: several issue kinds in one parse, order and all messages ──────
  [
    "mixed issue kinds",
    z.strictObject({ a: z.string().min(3), b: z.number().max(1), c: z.email() }),
    [{ a: "x", b: 9, c: "no", extra: true }],
  ],
];

describe("lean runtime parity — issues built by the real virtual module", () => {
  for (const [label, schema, inputs] of CASES) {
    it(label, () => {
      expectLeanParity(schema, inputs, "lean");
    });
  }
});

/**
 * Lean codegen for one case, generated the way `compileLeanLikeProduction`
 * generates it — refs collected included, since a schema whose predicate is
 * held in `__rf` (z.custom, a captured refine) reaches a different emit path
 * when extraction has nowhere to park it.
 */
function generateLean(schema: z.ZodType, name: string): { code: string; usedHelpers: Set<string> } {
  const refEntries: RefEntry[] = [];
  const generated = generateValidator(extractSchema(schema, refEntries), name, {
    refCount: refEntries.length,
    mode: "lean",
  });
  return { code: generated.code, usedHelpers: generated.usedHelpers };
}

/** Helper names every case in {@link CASES} causes lean codegen to reference. */
function collectUsedHelpers(): Set<string> {
  const used = new Set<string>();
  for (const [label, schema] of CASES) {
    for (const helper of generateLean(schema, `lean_${label}`).usedHelpers) used.add(helper);
  }
  return used;
}

/**
 * Argument counts observed at every `name(` call site in `code`, ignoring
 * commas nested inside parentheses, brackets, braces or string literals — the
 * lean call sites pass object literals and array paths as single arguments.
 */
function callArities(code: string, name: string): number[] {
  const arities: number[] = [];
  for (let at = code.indexOf(`${name}(`); at !== -1; at = code.indexOf(`${name}(`, at + 1)) {
    if (/[\w$]/.test(code[at - 1] ?? "")) continue; // a longer identifier ending in `name`
    const open = at + name.length;
    let depth = 0;
    let commas = 0;
    let quote = "";
    let close = open;
    for (let i = open; i < code.length; i++) {
      const ch = code[i] as string;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      } else if (ch === "," && depth === 1) {
        commas++;
      }
    }
    arities.push(code.slice(open + 1, close).trim() === "" ? 0 : commas + 1);
  }
  return arities;
}

/** Declared parameter count of `function name(a,b,c)` in the runtime source. */
function declaredArity(source: string, name: string): number | null {
  const match = new RegExp(`function ${name}\\(([^)]*)\\)`).exec(source);
  if (!match) return null;
  const params = (match[1] ?? "").trim();
  return params === "" ? 0 : params.split(",").length;
}

describe("lean runtime module ↔ codegen agreement", () => {
  const used = collectUsedHelpers();

  it("names a helper for every issue kind the cases above produce", () => {
    expect(used.size).toBeGreaterThan(0);
    for (const helper of used) {
      expect(ALL_HELPER_NAMES, `codegen emitted an unregistered helper: ${helper}`).toContain(
        helper,
      );
    }
  });

  it("resolves every emitted helper to a declaration in the module source", () => {
    // The MISSING_EXPORT failure mode (field incident: __zcUK). ALL_HELPER_NAMES
    // agreeing is not enough — the SOURCE has to declare the binding, because
    // that string is what the bundler compiles.
    for (const helper of used) {
      expect(RUNTIME_SOURCE, `helper not declared by the runtime module: ${helper}`).toMatch(
        new RegExp(`export (?:function|const) ${helper}\\b`),
      );
    }
  });

  it("exercises every issue factory and runtime helper in the registries", () => {
    // Coverage guard: a new entry in either registry that no case above
    // reaches would otherwise ship with its runtime behaviour untested.
    for (const name of [...Object.keys(ISSUE_DECLS), ...Object.keys(RUNTIME_HELPER_DECLS)]) {
      expect([...used], `no lean case exercises ${name}`).toContain(name);
    }
  });

  it("passes no more arguments than each issue factory declares", () => {
    // Arity drift is silent: an extra positional argument is dropped, and a
    // removed parameter shifts every later field onto the wrong key.
    for (const [label, schema] of CASES) {
      const generated = generateLean(schema, `arity_${label}`);
      for (const helper of generated.usedHelpers) {
        const declared = declaredArity(RUNTIME_SOURCE, helper);
        if (declared === null) continue; // const-declared (regexes, __zcHop)
        for (const observed of callArities(generated.code, helper)) {
          expect(
            observed,
            `${label}: ${helper} called with ${observed} args but declares ${declared}`,
          ).toBeLessThanOrEqual(declared);
        }
      }
    }
  });
});
