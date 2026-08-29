/**
 * Seeded structural fuzz.
 *
 * The hand-written suites enumerate shapes someone thought of. This one
 * enumerates combinations nobody did: a deterministic generator builds a schema
 * out of the compiler's whole vocabulary — every leaf kind, every container,
 * every wrapper — and hands it inputs that are valid, invalid, and simply
 * foreign. Everything is compared through {@link expectParity}, so a divergence
 * in the verdict, the output value, the issue list, the issue SHAPE or the
 * rendered `error.message` fails here.
 *
 * It has already paid for itself. Four bugs no enumerated case reached came out
 * of it, each now pinned by name in uncovered-api-parity.test.ts:
 *   - a tuple whose length issue did not abort its union option;
 *   - `z.string().min(2)` over `[]` losing the `too_small` that zod's `when`
 *     predicate lets through;
 *   - `z.exactOptional(z.string()).nullable()` reporting for a key zod skips;
 *   - a rest tuple's required `z.any()` slot past the end not landing as an
 *     own `undefined` in the output.
 *
 * Failures are reproducible: the label IS the seed, and `buildSeed(n)` rebuilds
 * that exact schema. The generator uses an explicit LCG rather than
 * `Math.random` so a green run means the same thing tomorrow.
 */
import { describe, it } from "vite-plus/test";
import { z } from "zod";
import { expectLeanParity, expectParity } from "./parity-harness.js";

/** Deterministic LCG so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

type Gen = { schema: z.ZodType; good: () => unknown; bad: () => unknown };

const LEAVES: ((r: () => number) => Gen)[] = [
  () => ({ schema: z.string(), good: () => "abc", bad: () => 1 }),
  () => ({ schema: z.string().min(2).max(5), good: () => "abc", bad: () => "a" }),
  () => ({ schema: z.string().trim(), good: () => "  x  ", bad: () => 1 }),
  () => ({ schema: z.number(), good: () => 42, bad: () => "x" }),
  () => ({ schema: z.number().int().positive(), good: () => 7, bad: () => -1.5 }),
  () => ({ schema: z.boolean(), good: () => true, bad: () => "true" }),
  () => ({ schema: z.bigint(), good: () => 7n, bad: () => 7 }),
  () => ({ schema: z.date(), good: () => new Date(0), bad: () => "2020" }),
  () => ({ schema: z.literal("lit"), good: () => "lit", bad: () => "nope" }),
  () => ({ schema: z.enum(["a", "b", "c"]), good: () => "b", bad: () => "z" }),
  () => ({ schema: z.null(), good: () => null, bad: () => 0 }),
  () => ({ schema: z.undefined(), good: () => undefined, bad: () => 0 }),
  () => ({ schema: z.any(), good: () => 1, bad: () => 1 }),
  () => ({ schema: z.unknown(), good: () => 1, bad: () => 1 }),
  () => ({ schema: z.email(), good: () => "a@b.com", bad: () => "nope" }),
  () => ({ schema: z.uuid(), good: () => "123e4567-e89b-42d3-a456-426614174000", bad: () => "x" }),
  () => ({ schema: z.coerce.number(), good: () => "5", bad: () => "x" }),
  () => ({ schema: z.stringbool(), good: () => "true", bad: () => "maybe" }),
  () => ({ schema: z.string().default("d"), good: () => undefined, bad: () => 1 }),
  () => ({ schema: z.number().catch(0), good: () => "anything", bad: () => "also fine" }),
  () => ({ schema: z.string().optional(), good: () => undefined, bad: () => 1 }),
  () => ({ schema: z.string().nullable(), good: () => null, bad: () => 1 }),
  () => ({ schema: z.exactOptional(z.string()), good: () => "x", bad: () => 1 }),
  () => ({ schema: z.string().prefault("p"), good: () => undefined, bad: () => 1 }),
  () => ({ schema: z.string().optional().nonoptional(), good: () => "x", bad: () => undefined }),
  () => ({
    schema: z.string().transform((v) => v.length),
    good: () => "abc",
    bad: () => 1,
  }),
  () => ({
    schema: z.number().refine((v) => v > 0, "positive"),
    good: () => 5,
    bad: () => -5,
  }),
  () => ({ schema: z.string().readonly(), good: () => "x", bad: () => 1 }),
  () => ({ schema: z.string().brand("B") as unknown as z.ZodType, good: () => "x", bad: () => 1 }),
  () => ({ schema: z.file(), good: () => new File(["x"], "a.txt"), bad: () => "x" }),
];

const KEYS = ["a", "b", "c", "d", "0", "kebab-key", "__proto__x", "constructor"];

function build(r: () => number, depth: number): Gen {
  if (depth <= 0 || r() < 0.34) {
    const make = LEAVES[Math.floor(r() * LEAVES.length)] as (r: () => number) => Gen;
    return make(r);
  }
  const kind = Math.floor(r() * 10);
  const inner = build(r, depth - 1);
  switch (kind) {
    case 0:
      return {
        schema: z.array(inner.schema),
        good: () => [inner.good(), inner.good()],
        bad: () => [inner.good(), inner.bad()],
      };
    case 1: {
      const n = 1 + Math.floor(r() * 3);
      const keys = KEYS.slice(0, n);
      const parts = keys.map((k) => [k, build(r, depth - 1)] as const);
      const shape = Object.fromEntries(parts.map(([k, g]) => [k, g.schema]));
      const mode = Math.floor(r() * 3);
      const schema =
        mode === 0 ? z.object(shape) : mode === 1 ? z.strictObject(shape) : z.looseObject(shape);
      return {
        schema,
        good: () => Object.fromEntries(parts.map(([k, g]) => [k, g.good()])),
        bad: () => Object.fromEntries(parts.map(([k, g], i) => [k, i === 0 ? g.bad() : g.good()])),
      };
    }
    case 2:
      return {
        schema: z.record(z.string(), inner.schema),
        good: () => ({ k1: inner.good() }),
        bad: () => ({ k1: inner.bad() }),
      };
    case 3: {
      const second = build(r, depth - 1);
      return {
        schema: z.tuple([inner.schema, second.schema]),
        good: () => [inner.good(), second.good()],
        bad: () => [inner.bad(), second.good()],
      };
    }
    case 4: {
      const second = build(r, depth - 1);
      return {
        schema: z.union([inner.schema, second.schema]),
        good: () => inner.good(),
        bad: () => Symbol("no-arm-matches"),
      };
    }
    case 5:
      return {
        schema: z.set(inner.schema),
        good: () => new Set([inner.good()]),
        bad: () => new Set([inner.bad()]),
      };
    case 6:
      return {
        schema: z.map(z.string(), inner.schema),
        good: () => new Map([["k", inner.good()]]),
        bad: () => new Map([["k", inner.bad()]]),
      };
    case 7:
      return { schema: inner.schema.optional(), good: inner.good, bad: inner.bad };
    case 8:
      return { schema: inner.schema.nullable(), good: () => null, bad: inner.bad };
    case 9: {
      const second = build(r, depth - 1);
      return {
        schema: z.object({ t: z.literal("x"), v: inner.schema, w: second.schema }),
        good: () => ({ t: "x", v: inner.good(), w: second.good() }),
        bad: () => ({ t: "x", v: inner.bad(), w: second.good() }),
      };
    }
    default:
      return inner;
  }
}

/** Rebuild the schema for a given seed — the label in a failure names it. */
function buildSeed(seed: number): Gen {
  return build(rng(seed * 7919), seed % 5 === 0 ? 4 : 3);
}

/**
 * Inputs every schema is additionally probed with. `Object.create(null)` and a
 * JSON-parsed `__proto__` key are deliberately ABSENT: both are accepted or
 * rejected identically, but a record hands its input straight back where zod
 * rebuilds, so the OUTPUT differs — pinned as a known divergence rather than
 * silently tolerated here. See known-divergences.test.ts.
 */
const FOREIGN: readonly unknown[] = [
  undefined,
  null,
  0,
  "",
  [],
  {},
  new Date(0),
  new Map(),
  new Set(),
  Symbol("sym"),
];

describe("structural fuzz — generated schemas match zod", () => {
  for (let seed = 1; seed <= 250; seed++) {
    it(`seed ${seed}`, () => {
      const gen = buildSeed(seed);
      const inputs = [gen.good(), gen.bad(), gen.good(), gen.bad(), ...FOREIGN];
      expectParity(gen.schema, inputs, `fuzz${seed}`);
      expectLeanParity(gen.schema, inputs, `fuzzLean${seed}`);
    });
  }
});
