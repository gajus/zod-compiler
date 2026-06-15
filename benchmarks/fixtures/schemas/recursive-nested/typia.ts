import typia, { type tags } from "typia";

interface Comment {
  id: string;
  author: string & tags.MinLength<1>;
  body: string & tags.MinLength<1>;
  replies: Comment[];
}

interface CommentThread {
  threadId: string;
  locked: boolean;
  root: Comment;
}

export const typiaValidateThread = typia.createValidate<CommentThread>();
