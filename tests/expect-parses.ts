import ts from "typescript";
import { expect } from "vite-plus/test";

/**
 * Assert emitted code is syntactically valid TypeScript.
 *
 * Asserting that output CONTAINS the right strings cannot catch output that does
 * not parse. A callback whose source text is not an expression — a method
 * shorthand lifted off an object literal — once made `zod-compiler generate`
 * report success and exit 0 while writing a file neither tsc nor node could
 * read, and the emitter has produced a bare `var __zs=;` before that. Both are
 * the same escape: a `toContain` suite is blind to broken syntax around the
 * fragment it looks for.
 *
 * Uses `transpileModule` rather than reading a SourceFile's `parseDiagnostics`,
 * which is not on the public type and would need a cast. Note this catches
 * SYNTAX only: errors TypeScript defers to its checker (a top-level `return`, a
 * stray `super`) parse clean here, so it bounds rather than replaces executing
 * the output.
 */
export function expectParses(content: string, label = "emitted"): void {
  const { diagnostics } = ts.transpileModule(content, {
    fileName: label.endsWith(".tsx") ? "emitted.tsx" : "emitted.ts",
    reportDiagnostics: true,
  });
  const messages = (diagnostics ?? []).map(
    (diagnostic) =>
      `${String(diagnostic.start)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
  );
  expect(messages, `${label} must parse`).toStrictEqual([]);
}
