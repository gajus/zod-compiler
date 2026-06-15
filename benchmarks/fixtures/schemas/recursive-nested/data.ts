import type { z } from "zod";
import type { CommentThreadSchema } from "./zod.js";

type Comment = z.infer<typeof CommentThreadSchema>["root"];

function makeComment(depth: number, breadth: number): Comment {
  if (depth <= 0) return { id: "c-leaf", author: "user", body: "leaf reply", replies: [] };
  return {
    id: `c-d${depth}`,
    author: "user",
    body: `comment depth ${depth}`,
    replies: Array.from({ length: breadth }, () => makeComment(depth - 1, breadth)),
  };
}

export const validThreadShallow: z.infer<typeof CommentThreadSchema> = {
  threadId: "thread-1",
  locked: false,
  root: makeComment(2, 2), // 7 comment nodes
};

export const validThreadDeep: z.infer<typeof CommentThreadSchema> = {
  threadId: "thread-2",
  locked: false,
  root: makeComment(4, 3), // 121 comment nodes
};
