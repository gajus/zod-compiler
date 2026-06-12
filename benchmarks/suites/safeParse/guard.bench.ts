import { bench, describe } from "vitest";
import {
  ajvApiResponse,
  ajvUser,
  aotApiResponse,
  aotUser,
  ApiResponseSchema,
  typiaIsApiResponse,
  typiaIsUser,
  UserSchema,
  validApiResponse10,
  validUser,
} from "../../fixtures/schemas/index.js";

// Boolean type guard ("does this match?") — the cheapest validation question.
// zod-compiler's `.is()` is the compiled fast-check itself: one boolean
// expression, no SafeParseResult object, no issues array. Compared against
// `.safeParse().success` (allocates the result wrapper) and the AOT peers
// whose guards are also bare booleans (typia `createIs`, ajv compiled).

describe("type guard: medium object — valid user", () => {
  bench("zod-compiler .is", () => {
    aotUser.is(validUser);
  });
  bench("zod-compiler .safeParse().success", () => {
    aotUser.safeParse(validUser);
  });
  bench("zod .safeParse().success", () => {
    UserSchema.safeParse(validUser);
  });
  bench("typia is", () => {
    typiaIsUser(validUser);
  });
  bench("ajv", () => {
    ajvUser(validUser);
  });
});

describe("type guard: large object — 10 items", () => {
  bench("zod-compiler .is", () => {
    aotApiResponse.is(validApiResponse10);
  });
  bench("zod-compiler .safeParse().success", () => {
    aotApiResponse.safeParse(validApiResponse10);
  });
  bench("zod .safeParse().success", () => {
    ApiResponseSchema.safeParse(validApiResponse10);
  });
  bench("typia is", () => {
    typiaIsApiResponse(validApiResponse10);
  });
  bench("ajv", () => {
    ajvApiResponse(validApiResponse10);
  });
});
