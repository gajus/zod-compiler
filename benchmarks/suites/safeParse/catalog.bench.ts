import { bench, describe } from "vite-plus/test";
import * as fixtures from "../../fixtures/schemas/index.js";

// Bound once, outside the timed functions: under Vitest's module runner each use
// of an imported name is a getter call per module it passes through (three for
// the fixtures), which bundled code never pays and which added ~50 ns per row.
const {
  aotCatalogPage,
  aotCatalogProduct,
  CatalogPageSchema,
  CatalogProductSchema,
  invalidCatalogProduct,
  v3CatalogPageSchema,
  v3CatalogProductSchema,
  validCatalogPage,
  validCatalogProduct,
} = fixtures;

// A schema module whose schemas share sub-shapes (see fixtures/schemas/catalog):
// `z.url()` keeps the error-collecting walk on the hot path, and that walk
// reaches Money and Image through shared walks.

describe("safeParse: catalog product with image URLs — valid", () => {
  bench("zod", () => {
    CatalogProductSchema.safeParse(validCatalogProduct);
  });
  bench("zod v3", () => {
    v3CatalogProductSchema.safeParse(validCatalogProduct);
  });
  bench("zod-compiler", () => {
    aotCatalogProduct.safeParse(validCatalogProduct);
  });
});

describe("safeParse: catalog product with image URLs — invalid", () => {
  bench("zod", () => {
    CatalogProductSchema.safeParse(invalidCatalogProduct);
  });
  bench("zod v3", () => {
    v3CatalogProductSchema.safeParse(invalidCatalogProduct);
  });
  bench("zod-compiler", () => {
    aotCatalogProduct.safeParse(invalidCatalogProduct);
  });
});

describe("safeParse: catalog page — 20 products with image URLs", () => {
  bench("zod", () => {
    CatalogPageSchema.safeParse(validCatalogPage);
  });
  bench("zod v3", () => {
    v3CatalogPageSchema.safeParse(validCatalogPage);
  });
  bench("zod-compiler", () => {
    aotCatalogPage.safeParse(validCatalogPage);
  });
});
