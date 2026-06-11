import { ajv } from "../ajv-instance.js";

export const ajvTuple = ajv.compile({
  type: "array",
  items: [{ type: "string" }, { type: "integer" }, { type: "boolean" }],
  minItems: 3,
  maxItems: 3,
});

export const ajvRecord = ajv.compile({
  type: "object",
  additionalProperties: { type: "number" },
});

// set: ajv does not support JS Set (JSON Schema operates on JSON values)
// map: ajv does not support JS Map (JSON Schema operates on JSON values)
