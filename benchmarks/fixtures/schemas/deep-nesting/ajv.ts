import { ajv } from "../ajv-instance.js";

// additionalProperties left at its default (true) to match zod's non-strict
// z.object (unknown keys allowed) and avoid charging ajv for excess-key scans.
export const ajvDeepLayout = ajv.compile({
  $id: "DeepLayout",
  type: "object",
  $defs: {
    widget: {
      type: "object",
      properties: {
        id: { type: "integer", exclusiveMinimum: 0 },
        label: { type: "string", minLength: 1, maxLength: 80 },
        visible: { type: "boolean" },
        weight: { type: "number" },
      },
      required: ["id", "label", "visible", "weight"],
    },
    panel1: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        a: { $ref: "#/$defs/widget" },
        b: { $ref: "#/$defs/widget" },
        c: { $ref: "#/$defs/widget" },
      },
      required: ["title", "a", "b", "c"],
    },
    panel2: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        a: { $ref: "#/$defs/panel1" },
        b: { $ref: "#/$defs/panel1" },
        c: { $ref: "#/$defs/panel1" },
      },
      required: ["title", "a", "b", "c"],
    },
    panel3: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        a: { $ref: "#/$defs/panel2" },
        b: { $ref: "#/$defs/panel2" },
        c: { $ref: "#/$defs/panel2" },
      },
      required: ["title", "a", "b", "c"],
    },
    panel4: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        a: { $ref: "#/$defs/panel3" },
        b: { $ref: "#/$defs/panel3" },
        c: { $ref: "#/$defs/panel3" },
      },
      required: ["title", "a", "b", "c"],
    },
  },
  properties: {
    name: { type: "string", minLength: 1 },
    header: { $ref: "#/$defs/panel4" },
    body: { $ref: "#/$defs/panel4" },
    footer: { $ref: "#/$defs/panel4" },
  },
  required: ["name", "header", "body", "footer"],
});
