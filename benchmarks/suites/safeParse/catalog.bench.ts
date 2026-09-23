import { bench, describe } from "vite-plus/test";
import {
  aotCatalogPage,
  aotCatalogProduct,
  CatalogPageSchema,
  CatalogProductSchema,
  invalidCatalogProduct,
  v3CatalogPageSchema,
  v3CatalogProductSchema,
  validCatalogPage,
  validCatalogProduct,
} from "../../fixtures/schemas/index.js";

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
