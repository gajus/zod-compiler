import { bench, describe } from "vite-plus/test";
import * as fixtures from "../../fixtures/schemas/index.js";

// Bound once, outside the timed functions: under Vitest's module runner each use
// of an imported name is a getter call per module it passes through (three for
// the fixtures), which bundled code never pays and which added ~50 ns per row.
const {
  ajvThread,
  aotThread,
  CommentThreadSchema,
  typiaValidateThread,
  v3CommentThreadSchema,
  validThreadDeep,
  validThreadShallow,
} = fixtures;

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
