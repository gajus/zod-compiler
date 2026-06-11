import { bench, describe } from "vitest";
import {
  aotEventLog,
  aotFallbackArray,
  aotPartialFallback,
  EventLogSchema,
  FallbackArraySchema,
  PartialFallbackObjectSchema,
  v3EventLogSchema,
  v3FallbackArraySchema,
  v3PartialFallbackObjectSchema,
  validEventLog,
  validFallbackArray10,
  validFallbackArray50,
  validPartialFallbackObject,
} from "../../fixtures/schemas/index.js";

// ─── Multi-feature Scenario ─────────────────────────────────────────────────

describe("safeParse: event log (uuid + discUnion + tuple + record + date)", () => {
  bench("zod", () => {
    EventLogSchema.safeParse(validEventLog);
  });
  bench("zod v3", () => {
    v3EventLogSchema.safeParse(validEventLog);
  });
  bench("zod-compiler", () => {
    aotEventLog.safeParse(validEventLog);
  });
});

// ─── Partial Fallback (zod vs zod-compiler) ──────────────────────────────────────
// These schemas contain zero-capture transform(), fully optimized at build time since v0.16.0.
// ajv/typia are excluded: transforms are a Zod-specific feature.

describe("safeParse: object with zero-capture transform", () => {
  bench("zod", () => {
    PartialFallbackObjectSchema.safeParse(validPartialFallbackObject);
  });
  bench("zod v3", () => {
    v3PartialFallbackObjectSchema.safeParse(validPartialFallbackObject);
  });
  bench("zod-compiler", () => {
    aotPartialFallback.safeParse(validPartialFallbackObject);
  });
});

describe("safeParse: array 10 items with zero-capture transform", () => {
  bench("zod", () => {
    FallbackArraySchema.safeParse(validFallbackArray10);
  });
  bench("zod v3", () => {
    v3FallbackArraySchema.safeParse(validFallbackArray10);
  });
  bench("zod-compiler", () => {
    aotFallbackArray.safeParse(validFallbackArray10);
  });
});

describe("safeParse: array 50 items with zero-capture transform", () => {
  bench("zod", () => {
    FallbackArraySchema.safeParse(validFallbackArray50);
  });
  bench("zod v3", () => {
    v3FallbackArraySchema.safeParse(validFallbackArray50);
  });
  bench("zod-compiler", () => {
    aotFallbackArray.safeParse(validFallbackArray50);
  });
});
