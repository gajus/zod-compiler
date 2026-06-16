/**
 * Impact of the `stripUnknownKeys` build option.
 *
 * Each group compares three validators on the SAME input:
 *   - zod                   — always strips, always allocates a fresh object
 *   - zod-compiler (keep)   — default: returns the input by reference (no strip)
 *   - zod-compiler (strip)  — stripUnknownKeys: rebuilds a fresh object
 *
 * Two input shapes per schema:
 *   - clean  — no extra keys; shows the allocation tax strip pays even when
 *              there is nothing to remove (keep stays a zero-alloc by-ref return)
 *   - dirty  — extra/unknown keys (overposting); the sanitization case. keep
 *              FORWARDS the extras (no protection); strip and zod drop them.
 */
import { bench, describe } from "vitest";
// Zod baselines from the shared fixtures; the strip fixture is imported directly
// (not via the barrel) because it alone reaches into compiler internals to build
// both keep/strip variants — keeping that coupling out of every other bench.
import { ApiResponseSchema, UserSchema } from "../../fixtures/schemas/objects/zod.js";
import {
  cleanApiResponse,
  cleanUser,
  cleanWide,
  dirtyApiResponse,
  dirtyUser,
  dirtyWide,
  keepApiResponse,
  keepUser,
  keepWide,
  stripApiResponse,
  stripUser,
  stripWide,
  WideSchema,
} from "../../fixtures/schemas/strip/index.js";

describe("strip: medium object (7 keys) — clean input", () => {
  bench("zod (strips)", () => {
    UserSchema.safeParse(cleanUser);
  });
  bench("zod-compiler (keep, by-ref)", () => {
    keepUser(cleanUser);
  });
  bench("zod-compiler (strip)", () => {
    stripUser(cleanUser);
  });
});

describe("strip: medium object (7 keys) — dirty input (3 extra keys)", () => {
  bench("zod (strips)", () => {
    UserSchema.safeParse(dirtyUser);
  });
  bench("zod-compiler (keep, forwards extras)", () => {
    keepUser(dirtyUser);
  });
  bench("zod-compiler (strip)", () => {
    stripUser(dirtyUser);
  });
});

describe("strip: wide object (20 keys) — clean input", () => {
  bench("zod (strips)", () => {
    WideSchema.safeParse(cleanWide);
  });
  bench("zod-compiler (keep, by-ref)", () => {
    keepWide(cleanWide);
  });
  bench("zod-compiler (strip)", () => {
    stripWide(cleanWide);
  });
});

describe("strip: wide object (20 keys) — dirty input (20 extra keys)", () => {
  bench("zod (strips)", () => {
    WideSchema.safeParse(dirtyWide);
  });
  bench("zod-compiler (keep, forwards extras)", () => {
    keepWide(dirtyWide);
  });
  bench("zod-compiler (strip)", () => {
    stripWide(dirtyWide);
  });
});

describe("strip: nested API response — clean input", () => {
  bench("zod (strips)", () => {
    ApiResponseSchema.safeParse(cleanApiResponse);
  });
  bench("zod-compiler (keep, by-ref)", () => {
    keepApiResponse(cleanApiResponse);
  });
  bench("zod-compiler (strip)", () => {
    stripApiResponse(cleanApiResponse);
  });
});

describe("strip: nested API response — dirty input (extras at every level)", () => {
  bench("zod (strips)", () => {
    ApiResponseSchema.safeParse(dirtyApiResponse);
  });
  bench("zod-compiler (keep, forwards extras)", () => {
    keepApiResponse(dirtyApiResponse);
  });
  bench("zod-compiler (strip)", () => {
    stripApiResponse(dirtyApiResponse);
  });
});
