import { bench, describe } from "vite-plus/test";
import * as fixtures from "../../fixtures/schemas/index.js";

// Bound once, outside the timed functions: under Vitest's module runner each use
// of an imported name is a getter call per module it passes through (three for
// the fixtures), which bundled code never pays and which added ~50 ns per row.
const {
  ajvDiscriminatedUnion,
  aotDiscUnion,
  aotLargeDiscUnion,
  aotPlainTaggedUnion,
  DiscriminatedUnionSchema,
  LargeDiscriminatedUnionSchema,
  PlainTaggedUnionSchema,
  typiaValidateDiscriminatedUnion,
  v3DiscriminatedUnionSchema,
  v3LargeDiscriminatedUnionSchema,
  v3PlainTaggedUnionSchema,
  validClickEvent,
  validLargeEvents,
} = fixtures;

describe("safeParse: discriminatedUnion (3 options)", () => {
  bench("zod", () => {
    DiscriminatedUnionSchema.safeParse(validClickEvent);
  });
  bench("zod v3", () => {
    v3DiscriminatedUnionSchema.safeParse(validClickEvent);
  });
  bench("zod-compiler", () => {
    aotDiscUnion.safeParse(validClickEvent);
  });
  bench("typia", () => {
    typiaValidateDiscriminatedUnion(validClickEvent);
  });
  bench("ajv", () => {
    ajvDiscriminatedUnion(validClickEvent);
  });
});

describe("safeParse: discriminatedUnion (8 options, rotating input)", () => {
  // Rotate through one valid input per option so the switch dispatches to every
  // case. The index step is identical across all rows, so it cancels out of any
  // cross-row comparison.
  let i = 0;
  const next = () => validLargeEvents[i++ % validLargeEvents.length];

  bench("zod", () => {
    LargeDiscriminatedUnionSchema.safeParse(next());
  });
  bench("zod v3", () => {
    v3LargeDiscriminatedUnionSchema.safeParse(next());
  });
  bench("zod-compiler", () => {
    aotLargeDiscUnion.safeParse(next());
  });
});

describe("safeParse: plain union of 8 tagged objects (auto-discriminated)", () => {
  // An untagged z.union Zod validates by sequential trial, but zod-compiler
  // detects the disjoint literal `type` and dispatches via O(1) switch. Same
  // rotating inputs as the discriminated case.
  let i = 0;
  const next = () => validLargeEvents[i++ % validLargeEvents.length];

  bench("zod", () => {
    PlainTaggedUnionSchema.safeParse(next());
  });
  bench("zod v3", () => {
    v3PlainTaggedUnionSchema.safeParse(next());
  });
  bench("zod-compiler", () => {
    aotPlainTaggedUnion.safeParse(next());
  });
});

describe("is: discriminatedUnion (8 options, rotating input)", () => {
  // The zero-allocation `.is()` guard is the fast-check in isolation (no result
  // object), so it shows the per-case guard cost without safeParse's allocation
  // diluting it.
  let i = 0;
  const next = () => validLargeEvents[i++ % validLargeEvents.length];

  bench("zod-compiler .is()", () => {
    aotLargeDiscUnion.is(next());
  });
});
