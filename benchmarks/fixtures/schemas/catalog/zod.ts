import { z } from "zod";

// ─── Product catalog: an API module whose schemas share sub-shapes ──────────
// Money and Image recur across the module, and the product is itself nested in
// the page, so zod-compiler emits each repeated shape's error walk once per file
// and calls it from every schema that contains it — shared walks calling shared
// walks. `z.url()` has no single-pass build path, so both schemas run that
// error-collecting walk on every parse, valid input included.

const Money = z.object({
  amount: z.number().int().nonnegative(),
  currency: z.enum(["USD", "EUR", "GBP"]),
});

const Image = z.object({
  url: z.url(),
  alt: z.string().max(200).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const CatalogProductSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(200),
  price: Money,
  compareAtPrice: Money.nullable(),
  images: z.array(Image).max(10),
  tags: z.array(z.string().min(1)).max(20),
  active: z.boolean(),
});

export type CatalogProduct = z.infer<typeof CatalogProductSchema>;

export const CatalogPageSchema = z.object({
  items: z.array(CatalogProductSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});

export type CatalogPage = z.infer<typeof CatalogPageSchema>;
