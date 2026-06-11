/* oxlint-disable no-console -- compat harness prints its results */
/**
 * Cross-runtime smoke test for zod-compiler.
 *
 * Runs against the built dist/ output with no test framework dependencies,
 * so it works on Node.js, Bun, and Deno without any setup.
 *
 * Usage:
 *   pnpm build && node tests/compat.mjs
 *   bun tests/compat.mjs
 *   deno run -A tests/compat.mjs
 */

import { ZodRealError, z } from "zod";
import { generateValidator } from "../dist/core/codegen/index.js";
import { extractSchema } from "../dist/core/extract/index.js";
import { FIN_DECL } from "../dist/core/iife.js";
import { compile } from "../dist/index.js";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    failed++;
    // biome-ignore lint/suspicious/noConsole: test runner output
    console.error(`FAIL: ${message}`);
  } else {
    passed++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    failed++;
    // biome-ignore lint/suspicious/noConsole: test runner output
    console.error(`FAIL: ${message} — expected ${expected}, got ${actual}`);
  } else {
    passed++;
  }
}

// ─── extractSchema + generateValidator roundtrip ────────────────────────────

const userSchema = z.object({
  name: z.string().min(1).max(100),
  age: z.number().int().positive(),
  role: z.enum(["admin", "user"]),
  tags: z.array(z.string()),
  active: z.boolean(),
  nickname: z.string().optional(),
});

const ir = extractSchema(userSchema);
assert(ir !== null && ir !== undefined, "extractSchema returns an IR");
assertEqual(ir.type, "object", "IR type is object");

const result = generateValidator(ir, "user");
assert(typeof result.code === "string", "generateValidator produces code string");
assert(result.code.length > 0, "generated code is non-empty");
assert(typeof result.functionDef === "string", "generateValidator produces function def");

// Compile and run the generated code (pass __msg and __ZodError for localeError + ZodError).
// FIN_DECL provides the shared __fin finalizer that every safeParse_* function calls.
const __msg = z.config().localeError;
const fn = new Function(
  "__msg",
  "__ZodError",
  `${FIN_DECL}\n${result.code}\nreturn ${result.functionDef};`,
);
const safeParse = fn(__msg, ZodRealError);

// Valid input
const validInput = {
  name: "Alice",
  age: 30,
  role: "admin",
  tags: ["ts", "zod"],
  active: true,
};
const validResult = safeParse(validInput);
assertEqual(validResult.success, true, "valid input passes AOT validation");

// Invalid input (bad types)
const invalidInput = { name: 42, age: "old", role: "superadmin", tags: "nope", active: "yes" };
const invalidResult = safeParse(invalidInput);
assertEqual(invalidResult.success, false, "invalid input fails AOT validation");
assert(
  invalidResult.error && invalidResult.error.issues.length > 0,
  "invalid input has error issues",
);

// Invalid input (failed checks)
const badChecks = { name: "", age: -1, role: "admin", tags: [], active: true };
const badChecksResult = safeParse(badChecks);
assertEqual(badChecksResult.success, false, "check failures are caught");

// ─── compile (dev-time fallback) ────────────────────────────────────────────

const compiled = compile(z.string().min(3));

const fbValid = compiled.safeParse("hello");
assertEqual(fbValid.success, true, "compile safeParse valid input");

const fbInvalid = compiled.safeParse("ab");
assertEqual(fbInvalid.success, false, "compile safeParse invalid input");

// ─── Report ─────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noConsole: test runner output
console.log(`\ncompat.mjs: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
