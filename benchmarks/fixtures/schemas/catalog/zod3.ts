import { z } from "zod3";

// zod v3 mirrors of ./zod.ts. v3's `.url()` also parses the input with
// `new URL()`, so the rows compare like for like.
const Money = z.object({
  amount: z.number().int().nonnegative(),
  currency: z.enum(["USD", "EUR", "GBP"]),
});

const Image = z.object({
  url: z.string().url(),
  alt: z.string().max(200).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const v3CatalogProductSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  price: Money,
  compareAtPrice: Money.nullable(),
  images: z.array(Image).max(10),
  tags: z.array(z.string().min(1)).max(20),
  active: z.boolean(),
});

export const v3CatalogPageSchema = z.object({
  items: z.array(v3CatalogProductSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
