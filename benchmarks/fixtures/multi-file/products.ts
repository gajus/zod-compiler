import { z } from "zod";

export const ProductSchema = z.object({
  id: z.uuid(),
  sellerEmail: z.email(),
  name: z.string().min(1).max(200),
  price: z.number().positive(),
});

export const ReviewSchema = z.object({
  productId: z.uuid(),
  reviewerEmail: z.email(),
  rating: z.number().int().min(1).max(5),
  body: z.string().min(1).max(2000),
});
