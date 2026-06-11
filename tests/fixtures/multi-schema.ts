import { z } from "zod";
import { compile } from "#src/core/compile.js";

const UserSchema = z.object({
  name: z.string(),
  email: z.email(),
});

const ProductSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1),
  price: z.number().positive(),
});

export const validateUser = compile(UserSchema);
export const validateProduct = compile(ProductSchema);
