import { bench, describe } from "vite-plus/test";
import {
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
} from "../../fixtures/schemas/index.js";

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
