import { ajv } from "../ajv-instance.js";

export const ajvDiscriminatedUnion = ajv.compile({
  oneOf: [
    {
      type: "object",
      properties: {
        type: { const: "click" },
        x: { type: "integer" },
        y: { type: "integer" },
        target: { type: "string", minLength: 1 },
      },
      required: ["type", "x", "y", "target"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "scroll" },
        direction: { enum: ["up", "down"] },
        delta: { type: "number", exclusiveMinimum: 0 },
      },
      required: ["type", "direction", "delta"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "keypress" },
        key: { type: "string", minLength: 1 },
        modifiers: { type: "array", items: { type: "string" } },
      },
      required: ["type", "key", "modifiers"],
      additionalProperties: false,
    },
  ],
});
