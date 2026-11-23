import { bench, describe } from "vite-plus/test";
import * as fixtures from "../../fixtures/schemas/index.js";

// Bound once, outside the timed functions: under Vitest's module runner each use
// of an imported name is a getter call per module it passes through (three for
// the fixtures), which bundled code never pays and which added ~50 ns per row.
const {
  ajvDeepLayout,
  aotDeepLayout,
  DeepLayoutSchema,
  typiaValidateDeepLayout,
  v3DeepLayoutSchema,
  validDeepLayout,
} = fixtures;

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
