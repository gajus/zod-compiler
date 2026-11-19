import { z } from "zod";

// A schema reached THROUGH zod instead of through its own methods.
//
// The item is an ordinary exported schema. The page around it is not: a generic
// factory builds it per call, as an API client does per endpoint, so there is
// no export for a compiler to find and the page itself stays plain zod. What it
// parses its items with is the item's `_zod.run` — zod never calls a child's
// `safeParse` — which is where a compiled item answers (see `__zcZr`).
export const ComposedItemSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().min(3).max(20),
  email: z.email(),
  role: z.enum(["user", "admin"]),
  active: z.boolean(),
  referral: z.string().optional(),
});

export type ComposedItem = z.infer<typeof ComposedItemSchema>;

/** `Paginated<T>`: the wrapper every list endpoint shares. */
export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    nextCursor: z.string().nullable(),
  });
}

export const ComposedPageSchema = paginated(ComposedItemSchema);
