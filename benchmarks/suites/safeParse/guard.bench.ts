import { bench, describe } from "vite-plus/test";
import * as fixtures from "../../fixtures/schemas/index.js";

// Bound once, outside the timed functions: under Vitest's module runner each use
// of an imported name is a getter call per module it passes through (three for
// the fixtures), which bundled code never pays and which added ~50 ns per row.
const {
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
  wrongShapeUser,
} = fixtures;

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

// The other half of the guard question: input that does NOT match. The fast
// check's conjuncts are emitted cheapest-first, so a mismatch is decided on a
// type guard rather than on the schema's most expensive check (here, the email
// regex the declaration order would have run first).
describe("type guard: medium object — non-matching input", () => {
  bench("zod-compiler .is", () => {
    aotUser.is(wrongShapeUser);
  });
  bench("zod-compiler .safeParse().success", () => {
    aotUser.safeParse(wrongShapeUser);
  });
  bench("zod .safeParse().success", () => {
    UserSchema.safeParse(wrongShapeUser);
  });
  bench("typia is", () => {
    typiaIsUser(wrongShapeUser);
  });
  bench("ajv", () => {
    ajvUser(wrongShapeUser);
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
