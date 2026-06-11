import { ajv } from "../ajv-instance.js";

export const ajvSimpleString = ajv.compile({ type: "string" });

export const ajvStringWithChecks = ajv.compile({
  type: "string",
  minLength: 3,
  maxLength: 50,
});

export const ajvNumberWithChecks = ajv.compile({
  type: "integer",
  exclusiveMinimum: 0,
});

export const ajvSimpleEnum = ajv.compile({
  enum: ["admin", "user", "guest", "moderator"],
});
