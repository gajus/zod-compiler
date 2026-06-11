import { Ajv } from "ajv";
import addFormats from "ajv-formats";

export const ajv = new Ajv({ allErrors: true });
// @ts-expect-error ajv-formats CJS default export not callable under verbatimModuleSyntax
addFormats(ajv);
