import { z } from "zod";
import { compile } from "#src/core/compile.js";

const InternalSchema = z.object({
  name: z.string(),
  age: z.number(),
});

export const validateUser = compile(InternalSchema);

export const ProductSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1),
});
