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
 * that exact schema (see structural-gen.ts, which tests/zod-run.test.ts shares).
 */
import { describe, it } from "vite-plus/test";
import { expectLeanParity, expectParity } from "./parity-harness.js";
import { buildSeed, FOREIGN } from "./structural-gen.js";

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
