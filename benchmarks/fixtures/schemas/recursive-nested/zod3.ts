import { z } from "zod3";

const v3CommentSchema: z.ZodType = z.object({
  id: z.string(),
  author: z.string().min(1),
  body: z.string().min(1),
  replies: z.array(z.lazy(() => v3CommentSchema)),
});

export const v3CommentThreadSchema = z.object({
  threadId: z.string(),
  locked: z.boolean(),
  root: v3CommentSchema,
});
