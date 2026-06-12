import { bench, describe } from "vitest";
import {
  ajvDeepLayout,
  aotDeepLayout,
  DeepLayoutSchema,
  typiaValidateDeepLayout,
  v3DeepLayoutSchema,
  validDeepLayout,
} from "../../fixtures/schemas/index.js";

// A fixed object nested 4 panel levels deep (243 leaf widgets). The fully
// inlined fast-check would exceed V8's TurboFan budget and drop to the slower
// Maglev tier; zod-compiler's size-gated splitting keeps every emitted function
// on TurboFan (measured ~4.5x vs the un-split monolith).
describe("safeParse: deeply nested object — dashboard layout (243 leaves)", () => {
  bench("zod", () => {
    DeepLayoutSchema.safeParse(validDeepLayout);
  });
  bench("zod v3", () => {
    v3DeepLayoutSchema.safeParse(validDeepLayout);
  });
  bench("zod-compiler", () => {
    aotDeepLayout.safeParse(validDeepLayout);
  });
  bench("typia", () => {
    typiaValidateDeepLayout(validDeepLayout);
  });
  bench("ajv", () => {
    ajvDeepLayout(validDeepLayout);
  });
});
