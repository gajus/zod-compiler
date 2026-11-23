import { bench, describe } from "vite-plus/test";
import * as fixtures from "../../fixtures/schemas/index.js";

// Bound once, outside the timed functions: under Vitest's module runner each use
// of an imported name is a getter call per module it passes through (three for
// the fixtures), which bundled code never pays and which added ~50 ns per row.
const {
  ApiResponseSchema,
  aotApiResponse,
  aotUser,
  typiaAssertApiResponse,
  typiaAssertUser,
  UserSchema,
  v3ApiResponseSchema,
  v3UserSchema,
  validApiResponse100,
  validUser,
} = fixtures;

// parse() is the canonical zod entry point: throwing, returns data directly.
// Unlike safeParse it can skip the SafeParseResult allocation entirely.

describe("parse: medium object — valid user", () => {
  bench("zod", () => {
    UserSchema.parse(validUser);
  });
  bench("zod v3", () => {
    v3UserSchema.parse(validUser);
  });
  bench("zod-compiler", () => {
    aotUser.parse(validUser);
  });
  bench("typia (assert)", () => {
    typiaAssertUser(validUser);
  });
});

describe("parse: large object — 100 items", () => {
  bench("zod", () => {
    ApiResponseSchema.parse(validApiResponse100);
  });
  bench("zod v3", () => {
    v3ApiResponseSchema.parse(validApiResponse100);
  });
  bench("zod-compiler", () => {
    aotApiResponse.parse(validApiResponse100);
  });
  bench("typia (assert)", () => {
    typiaAssertApiResponse(validApiResponse100);
  });
});
