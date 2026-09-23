import type { CatalogPage, CatalogProduct } from "./zod.js";

function image(i: number) {
  return {
    url: `https://cdn.example.com/products/${i}.jpg`,
    alt: `Product photo ${i}`,
    width: 1200,
    height: 900,
  };
}

function makeProduct(i: number): CatalogProduct {
  return {
    id: `f47ac10b-58cc-4372-a567-${String(i).padStart(12, "0")}`,
    name: `Product ${i}`,
    price: { amount: 12_900 + i, currency: "USD" },
    compareAtPrice: { amount: 14_900 + i, currency: "USD" },
    images: [image(3 * i), image(3 * i + 1), image(3 * i + 2)],
    tags: ["new", "featured"],
    active: true,
  };
}

export const validCatalogProduct: CatalogProduct = makeProduct(1);

/** Failures inside two shared shapes: a negative price in an unknown currency, and a bad image URL. */
export const invalidCatalogProduct = {
  ...validCatalogProduct,
  price: { amount: -1, currency: "JPY" },
  images: [image(1), { ...image(2), url: "not a url" }],
};

export const validCatalogPage: CatalogPage = {
  items: Array.from({ length: 20 }, (_, i) => makeProduct(i)),
  total: 240,
  nextCursor: "cursor_20",
};
