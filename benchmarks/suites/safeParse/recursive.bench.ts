import { bench, describe } from "vite-plus/test";
import * as fixtures from "../../fixtures/schemas/index.js";

// Bound once, outside the timed functions: under Vitest's module runner each use
// of an imported name is a getter call per module it passes through (three for
// the fixtures), which bundled code never pays and which added ~50 ns per row.
const {
  ajvTree,
  aotTree,
  TreeNodeSchema,
  typiaValidateTree,
  v3TreeNodeSchema,
  validTreeDeep,
  validTreeShallow,
} = fixtures;

describe("safeParse: recursive tree — shallow (7 nodes)", () => {
  bench("zod", () => {
    TreeNodeSchema.safeParse(validTreeShallow);
  });
  bench("zod v3", () => {
    v3TreeNodeSchema.safeParse(validTreeShallow);
  });
  bench("zod-compiler", () => {
    aotTree.safeParse(validTreeShallow);
  });
  bench("typia", () => {
    typiaValidateTree(validTreeShallow);
  });
  bench("ajv", () => {
    ajvTree(validTreeShallow);
  });
});

describe("safeParse: recursive tree — deep (121 nodes)", () => {
  bench("zod", () => {
    TreeNodeSchema.safeParse(validTreeDeep);
  });
  bench("zod v3", () => {
    v3TreeNodeSchema.safeParse(validTreeDeep);
  });
  bench("zod-compiler", () => {
    aotTree.safeParse(validTreeDeep);
  });
  bench("typia", () => {
    typiaValidateTree(validTreeDeep);
  });
  bench("ajv", () => {
    ajvTree(validTreeDeep);
  });
});
