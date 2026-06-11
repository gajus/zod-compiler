import { bench, describe } from "vitest";
import {
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
} from "../../fixtures/schemas/index.js";

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
