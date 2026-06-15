import { ajv } from "../ajv-instance.js";

export const ajvThread = ajv.compile({
  $id: "CommentThread",
  type: "object",
  properties: {
    threadId: { type: "string" },
    locked: { type: "boolean" },
    root: { $ref: "Comment" },
  },
  required: ["threadId", "locked", "root"],
  additionalProperties: false,
  $defs: {
    Comment: {
      $id: "Comment",
      type: "object",
      properties: {
        id: { type: "string" },
        author: { type: "string", minLength: 1 },
        body: { type: "string", minLength: 1 },
        replies: {
          type: "array",
          items: { $ref: "Comment" },
        },
      },
      required: ["id", "author", "body", "replies"],
      additionalProperties: false,
    },
  },
});
