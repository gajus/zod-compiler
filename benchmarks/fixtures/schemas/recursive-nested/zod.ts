import { z } from "zod";

// A recursive schema (CommentSchema, with nested replies) that is NOT the root
// — it sits inside a larger response envelope. This is the common real-world
// shape (an API payload wrapping a recursive type). Before multi-target
// recursion support, the entire comment subtree fell back to Zod even though
// the envelope around it compiled.
const CommentSchema: z.ZodType = z.object({
  id: z.string(),
  author: z.string().min(1),
  body: z.string().min(1),
  replies: z.array(z.lazy(() => CommentSchema)),
});

export const CommentThreadSchema = z.object({
  threadId: z.string(),
  locked: z.boolean(),
  root: CommentSchema,
});
