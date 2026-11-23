import { bench, describe } from "vite-plus/test";
import * as fixtures from "../../fixtures/schemas/index.js";

// Bound once, outside the timed functions: under Vitest's module runner each use
// of an imported name is a getter call per module it passes through (three for
// the fixtures), which bundled code never pays and which added ~50 ns per row.
const {
  aotReadonlyArray,
  aotReadonlyField,
  aotReadonlyRoot,
  ReadonlyArraySchema,
  ReadonlyFieldSchema,
  ReadonlyRootSchema,
  v3ReadonlyArraySchema,
  v3ReadonlyFieldSchema,
  v3ReadonlyRootSchema,
  validReadonlyArray,
  validReadonlyField,
  validReadonlyRoot,
} = fixtures;

describe("safeParse: readonly primitive field (wrapper compiles away)", () => {
  bench("zod", () => {
    ReadonlyFieldSchema.safeParse(validReadonlyField);
  });
  bench("zod v3", () => {
    v3ReadonlyFieldSchema.safeParse(validReadonlyField);
  });
  bench("zod-compiler", () => {
    aotReadonlyField.safeParse(validReadonlyField);
  });
});

describe("safeParse: readonly root object (rebuild + freeze)", () => {
  bench("zod", () => {
    ReadonlyRootSchema.safeParse(validReadonlyRoot);
  });
  bench("zod v3", () => {
    v3ReadonlyRootSchema.safeParse(validReadonlyRoot);
  });
  bench("zod-compiler", () => {
    aotReadonlyRoot.safeParse(validReadonlyRoot);
  });
});

describe("safeParse: readonly array (copy + freeze)", () => {
  bench("zod", () => {
    ReadonlyArraySchema.safeParse(validReadonlyArray);
  });
  bench("zod v3", () => {
    v3ReadonlyArraySchema.safeParse(validReadonlyArray);
  });
  bench("zod-compiler", () => {
    aotReadonlyArray.safeParse(validReadonlyArray);
  });
});
