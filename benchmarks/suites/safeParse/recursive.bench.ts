import { bench, describe } from "vitest";
import {
  ajvTree,
  aotTree,
  TreeNodeSchema,
  typiaValidateTree,
  v3TreeNodeSchema,
  validTreeDeep,
  validTreeShallow,
} from "../../fixtures/schemas/index.js";

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
