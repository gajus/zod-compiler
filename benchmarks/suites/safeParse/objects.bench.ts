import { bench, describe } from "vite-plus/test";
import * as fixtures from "../../fixtures/schemas/index.js";

// Bound once, outside the timed functions: under Vitest's module runner each use
// of an imported name is a getter call per module it passes through (three for
// the fixtures), which bundled code never pays and which added ~50 ns per row.
const {
  ApiResponseSchema,
  ajvApiResponse,
  ajvUser,
  aotApiResponse,
  aotStrictRow,
  aotUser,
  aotUserIntersection,
  dirtyUser,
  invalidUser,
  StrictRowSchema,
  typiaValidateApiResponse,
  typiaValidateUser,
  UserSchema,
  UserIntersectionSchema,
  v3ApiResponseSchema,
  v3StrictRowSchema,
  v3UserSchema,
  v3UserIntersectionSchema,
  validApiResponse10,
  validApiResponse100,
  validStrictRow,
  validUser,
} = fixtures;

describe("safeParse: medium object — valid user", () => {
  bench("zod", () => {
    UserSchema.safeParse(validUser);
  });
  bench("zod v3", () => {
    v3UserSchema.safeParse(validUser);
  });
  bench("zod-compiler", () => {
    aotUser.safeParse(validUser);
  });
  bench("typia", () => {
    typiaValidateUser(validUser);
  });
  bench("ajv", () => {
    ajvUser(validUser);
  });
});

describe("safeParse: medium object — invalid user", () => {
  bench("zod", () => {
    UserSchema.safeParse(invalidUser);
  });
  bench("zod v3", () => {
    v3UserSchema.safeParse(invalidUser);
  });
  bench("zod-compiler", () => {
    aotUser.safeParse(invalidUser);
  });
  bench("typia", () => {
    typiaValidateUser(invalidUser);
  });
  bench("ajv", () => {
    ajvUser(invalidUser);
  });
});

describe("safeParse: disjoint object intersection — valid user", () => {
  bench("zod", () => {
    UserIntersectionSchema.safeParse(validUser);
  });
  bench("zod v3", () => {
    v3UserIntersectionSchema.safeParse(validUser);
  });
  bench("zod-compiler", () => {
    aotUserIntersection.safeParse(validUser);
  });
});

describe("safeParse: disjoint object intersection — invalid user", () => {
  bench("zod", () => {
    UserIntersectionSchema.safeParse(invalidUser);
  });
  bench("zod v3", () => {
    v3UserIntersectionSchema.safeParse(invalidUser);
  });
  bench("zod-compiler", () => {
    aotUserIntersection.safeParse(invalidUser);
  });
});

describe("safeParse: large object — 10 items", () => {
  bench("zod", () => {
    ApiResponseSchema.safeParse(validApiResponse10);
  });
  bench("zod v3", () => {
    v3ApiResponseSchema.safeParse(validApiResponse10);
  });
  bench("zod-compiler", () => {
    aotApiResponse.safeParse(validApiResponse10);
  });
  bench("typia", () => {
    typiaValidateApiResponse(validApiResponse10);
  });
  bench("ajv", () => {
    ajvApiResponse(validApiResponse10);
  });
});

describe("safeParse: large object — 100 items", () => {
  bench("zod", () => {
    ApiResponseSchema.safeParse(validApiResponse100);
  });
  bench("zod v3", () => {
    v3ApiResponseSchema.safeParse(validApiResponse100);
  });
  bench("zod-compiler", () => {
    aotApiResponse.safeParse(validApiResponse100);
  });
  bench("typia", () => {
    typiaValidateApiResponse(validApiResponse100);
  });
  bench("ajv", () => {
    ajvApiResponse(validApiResponse100);
  });
});

describe("safeParse: strict object — DB row (rejects unknown keys)", () => {
  bench("zod", () => {
    StrictRowSchema.safeParse(validStrictRow);
  });
  bench("zod v3", () => {
    v3StrictRowSchema.safeParse(validStrictRow);
  });
  bench("zod-compiler", () => {
    aotStrictRow.safeParse(validStrictRow);
  });
});

describe("safeParse: medium object — extra keys stripped (overposting)", () => {
  bench("zod", () => {
    UserSchema.safeParse(dirtyUser);
  });
  bench("zod v3", () => {
    v3UserSchema.safeParse(dirtyUser);
  });
  bench("zod-compiler", () => {
    aotUser.safeParse(dirtyUser);
  });
});
