import { bench, describe } from "vite-plus/test";
import { z } from "zod";
import {
  aotComposedItem,
  ComposedItemSchema,
  ComposedPageSchema,
  ComposedTaggedPageSchema,
  pageOverCompiledItem,
  pageOverCompiledTaggedItem,
  validComposedItem,
  validComposedPage,
  validComposedTaggedPage,
} from "../../fixtures/schemas/index.js";

// Both pages are plain zod, built by the same generic factory. Only the item
// differs: zod parses each one through `item._zod.run`, and a compiled item
// answers there.
describe("safeParse: generic page of a compiled item, page not compiled (20 items)", () => {
  bench("zod", () => {
    ComposedPageSchema.safeParse(validComposedPage);
  });
  bench("zod-compiler", () => {
    pageOverCompiledItem.safeParse(validComposedPage);
  });
});

// The same, over an item with an array field: one zod's traversal is handed a
// copy of rather than the caller's array.
describe("safeParse: generic page of a compiled item with an array field, page not compiled (20 items)", () => {
  bench("zod", () => {
    ComposedTaggedPageSchema.safeParse(validComposedTaggedPage);
  });
  bench("zod-compiler", () => {
    pageOverCompiledTaggedItem.safeParse(validComposedTaggedPage);
  });
});

// `z.safeParse(schema, x)` — zod's functional API, the style zod/mini code is
// written in — calls `schema._zod.run` and never the schema's own method.
describe("safeParse: functional API, z.safeParse(schema, value)", () => {
  bench("zod", () => {
    z.safeParse(ComposedItemSchema, validComposedItem);
  });
  bench("zod-compiler", () => {
    z.safeParse(aotComposedItem, validComposedItem);
  });
});
