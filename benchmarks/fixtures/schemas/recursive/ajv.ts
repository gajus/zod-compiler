import { ajv } from "../ajv-instance.js";

export const ajvTree = ajv.compile({
  $id: "TreeNode",
  type: "object",
  properties: {
    value: { type: "string", minLength: 1 },
    children: {
      type: "array",
      items: { $ref: "TreeNode" },
    },
  },
  required: ["value", "children"],
  additionalProperties: false,
});
