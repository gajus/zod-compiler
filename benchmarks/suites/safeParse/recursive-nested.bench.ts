import { bench, describe } from "vitest";
import {
  ajvThread,
  aotThread,
  CommentThreadSchema,
  typiaValidateThread,
  v3CommentThreadSchema,
  validThreadDeep,
  validThreadShallow,
} from "../../fixtures/schemas/index.js";

// Recursion that is NOT the compiled root: a recursive `Comment` type nested
// inside a response envelope. Before multi-target recursion support the comment
// subtree fell back to Zod (so zod-compiler tracked Zod here); it now compiles.

describe("safeParse: nested recursion — shallow (7 comment nodes)", () => {
  bench("zod", () => {
    CommentThreadSchema.safeParse(validThreadShallow);
  });
  bench("zod v3", () => {
    v3CommentThreadSchema.safeParse(validThreadShallow);
  });
  bench("zod-compiler", () => {
    aotThread.safeParse(validThreadShallow);
  });
  bench("typia", () => {
    typiaValidateThread(validThreadShallow);
  });
  bench("ajv", () => {
    ajvThread(validThreadShallow);
  });
});

describe("safeParse: nested recursion — deep (121 comment nodes)", () => {
  bench("zod", () => {
    CommentThreadSchema.safeParse(validThreadDeep);
  });
  bench("zod v3", () => {
    v3CommentThreadSchema.safeParse(validThreadDeep);
  });
  bench("zod-compiler", () => {
    aotThread.safeParse(validThreadDeep);
  });
  bench("typia", () => {
    typiaValidateThread(validThreadDeep);
  });
  bench("ajv", () => {
    ajvThread(validThreadDeep);
  });
});
