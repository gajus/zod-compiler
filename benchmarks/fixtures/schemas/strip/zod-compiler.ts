/**
 * Both strip-OFF (keep, the default) and strip-ON variants of the SAME schema,
 * compiled through the real extract → codegen pipeline so the only difference
 * is the `stripUnknownKeys` build option. Built at load time with `new Function`
 * (the same generated body the bundler plugin emits) because the plugin's
 * `stripUnknownKeys` is a single global flag — it can't produce both variants in
 * one build.
 */
import { ZodRealError, z } from "zod";
import { generateValidator } from "../../../../src/core/codegen/index.js";
import type { RefEntry } from "../../../../src/core/extract/index.js";
import { extractSchema } from "../../../../src/core/extract/index.js";
import { FAIL_CLASS_DECL, FIN_DECL, FIN_DEFERRED_DECL } from "../../../../src/core/iife.js";
import { ApiResponseSchema, UserSchema } from "../objects/zod.js";

const localizedFin = new Function(
  "__zcMsg",
  "__zcZodError",
  `${FAIL_CLASS_DECL}${FIN_DECL}; return __zcFin;`,
)(z.config().localeError, ZodRealError);

type Compiled = (input: unknown) => { success: boolean; data?: unknown };

function compileWith(schema: unknown, name: string, stripUnknownKeys: boolean): Compiled {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries, { stripUnknownKeys });
  const generated = generateValidator(ir, name, { refCount: refEntries.length });
  const factory = new Function(
    "__zcMsg",
    "__zcZodError",
    "__zcFin",
    "__rf",
    `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\n${generated.code}\nreturn ${generated.functionDef};`,
  );
  return factory(
    z.config().localeError,
    ZodRealError,
    localizedFin,
    refEntries.map((e) => e.schema),
  ) as Compiled;
}

// Wide flat object (20 string-or-number keys) — isolates the per-key copy cost.
export const WideSchema = z.object(
  Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, z.number()])),
);

export const keepUser = compileWith(UserSchema, "keepUser", false);
export const stripUser = compileWith(UserSchema, "stripUser", true);

export const keepApiResponse = compileWith(ApiResponseSchema, "keepApi", false);
export const stripApiResponse = compileWith(ApiResponseSchema, "stripApi", true);

export const keepWide = compileWith(WideSchema, "keepWide", false);
export const stripWide = compileWith(WideSchema, "stripWide", true);
