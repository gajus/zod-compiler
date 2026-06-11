import { bench, describe } from "vitest";
import {
  aotCapturedRefine,
  aotCapturedTransform,
  aotCapturedTransformObject,
  aotZeroCaptureRefineObject,
  aotZeroCaptureRefineString,
  aotZeroCaptureTransformObject,
  aotZeroCaptureTransformString,
  CapturedRefineSchema,
  CapturedTransformObjectSchema,
  CapturedTransformSchema,
  v3CapturedRefineSchema,
  v3CapturedTransformObjectSchema,
  v3CapturedTransformSchema,
  v3ZeroCaptureRefineObjectSchema,
  v3ZeroCaptureRefineStringSchema,
  v3ZeroCaptureTransformObjectSchema,
  v3ZeroCaptureTransformStringSchema,
  validCapturedRefineString,
  validCapturedTransformObject,
  validCapturedTransformString,
  validRefineObject,
  validRefineString,
  validTransformObject,
  validTransformString,
  ZeroCaptureRefineObjectSchema,
  ZeroCaptureRefineStringSchema,
  ZeroCaptureTransformObjectSchema,
  ZeroCaptureTransformStringSchema,
} from "../../fixtures/schemas/index.js";

// ─── Zero-capture transforms (fully optimized at build time) ────────────────
// ajv/typia excluded: transform() is a Zod-specific feature.

describe("safeParse: zero-capture transform — string", () => {
  bench("zod", () => {
    ZeroCaptureTransformStringSchema.safeParse(validTransformString);
  });
  bench("zod v3", () => {
    v3ZeroCaptureTransformStringSchema.safeParse(validTransformString);
  });
  bench("zod-compiler", () => {
    aotZeroCaptureTransformString.safeParse(validTransformString);
  });
});

describe("safeParse: zero-capture transform — object", () => {
  bench("zod", () => {
    ZeroCaptureTransformObjectSchema.safeParse(validTransformObject);
  });
  bench("zod v3", () => {
    v3ZeroCaptureTransformObjectSchema.safeParse(validTransformObject);
  });
  bench("zod-compiler", () => {
    aotZeroCaptureTransformObject.safeParse(validTransformObject);
  });
});

// ─── Zero-capture refines (inlined at build time) ──────────────────────────

describe("safeParse: zero-capture refine — string", () => {
  bench("zod", () => {
    ZeroCaptureRefineStringSchema.safeParse(validRefineString);
  });
  bench("zod v3", () => {
    v3ZeroCaptureRefineStringSchema.safeParse(validRefineString);
  });
  bench("zod-compiler", () => {
    aotZeroCaptureRefineString.safeParse(validRefineString);
  });
});

describe("safeParse: zero-capture refine — object", () => {
  bench("zod", () => {
    ZeroCaptureRefineObjectSchema.safeParse(validRefineObject);
  });
  bench("zod v3", () => {
    v3ZeroCaptureRefineObjectSchema.safeParse(validRefineObject);
  });
  bench("zod-compiler", () => {
    aotZeroCaptureRefineObject.safeParse(validRefineObject);
  });
});

// ─── Captured-variable effects (Zod fallback) ──────────────────────────────

describe("safeParse: captured transform — string", () => {
  bench("zod", () => {
    CapturedTransformSchema.safeParse(validCapturedTransformString);
  });
  bench("zod v3", () => {
    v3CapturedTransformSchema.safeParse(validCapturedTransformString);
  });
  bench("zod-compiler", () => {
    aotCapturedTransform.safeParse(validCapturedTransformString);
  });
});

describe("safeParse: captured transform — object", () => {
  bench("zod", () => {
    CapturedTransformObjectSchema.safeParse(validCapturedTransformObject);
  });
  bench("zod v3", () => {
    v3CapturedTransformObjectSchema.safeParse(validCapturedTransformObject);
  });
  bench("zod-compiler", () => {
    aotCapturedTransformObject.safeParse(validCapturedTransformObject);
  });
});

describe("safeParse: captured refine — string", () => {
  bench("zod", () => {
    CapturedRefineSchema.safeParse(validCapturedRefineString);
  });
  bench("zod v3", () => {
    v3CapturedRefineSchema.safeParse(validCapturedRefineString);
  });
  bench("zod-compiler", () => {
    aotCapturedRefine.safeParse(validCapturedRefineString);
  });
});
