/**
 * Issue object emit helpers.
 *
 * Each helper returns a string of the form `_e.push(...)` (or equivalent on a
 * caller-supplied issues variable). Two emit modes:
 *
 *  - inline (CLI .compiled.ts): emits the literal `{code:"too_small",...}` object.
 *  - lean (unplugin): emits a call like `__zcTS(min,origin,inclusive,input,path)`
 *    and registers the helper in `ctx.usedHelpers` so the transform layer can
 *    construct the corresponding `import` from `"virtual:zod-compiler/runtime"`.
 *
 * Centralizing all issue emission here means schema codegen files don't carry
 * the inline/lean branching; they just call `tooSmall(g, ...)` etc.
 *
 * Message resolution mirrors Zod, which consults the error map of the
 * INSTANCE that created the issue:
 *  - check-created issues (min/max/format/refine): per-check message only
 *    (options.message, extracted from `.min(3, "msg")`)
 *  - schema-created issues (invalid_type, enum/literal invalid_value, tuple
 *    length, invalid_union, invalid_key): schema-level message (g.typeMsg,
 *    from `z.string({ error: "msg" })`)
 * Helpers default per the most common call-site kind; size-issue emitters
 * accept `useTypeMsg: true` for node-level uses (tuple), and invalidValue
 * accepts `useTypeMsg: false` for check-level uses (file mime).
 * When no message lands, the __zcFin finalizer applies the locale default.
 */

import type { CodeGenContext } from "./context.js";
import { escapeString } from "./context.js";

/** Common slim slice of SlowGen + FastGen needed for issue emission. */
interface IssueGen {
  readonly issues: string;
  readonly input: string;
  readonly path: string;
  readonly ctx: CodeGenContext;
  readonly typeMsg?: string | undefined;
}

function pushIssue(g: IssueGen, body: string): string {
  return `${g.issues}.push(${body});`;
}

/** Resolve the effective static message for an issue site. */
function resolveMessage(
  g: IssueGen,
  explicit: string | undefined,
  useTypeMsg: boolean,
): string | undefined {
  return explicit ?? (useTypeMsg ? g.typeMsg : undefined);
}

/** `,message:"..."` fragment for inline object literals ("" when no message). */
function messageProp(m: string | undefined): string {
  return m === undefined ? "" : `,message:${escapeString(m)}`;
}

/** `,"..."` trailing argument fragment for lean factory calls ("" when no message). */
function messageArg(m: string | undefined): string {
  return m === undefined ? "" : `,${escapeString(m)}`;
}

export function tooSmall(
  g: IssueGen,
  minimum: string | number,
  origin: string,
  inclusive: boolean,
  options?: {
    exact?: boolean;
    input?: string;
    path?: string;
    message?: string | undefined;
    /** Set for node-level issues (tuple length) where schema error applies. */
    useTypeMsg?: boolean;
  },
): string {
  const input = options?.input ?? g.input;
  const path = options?.path ?? g.path;
  const exact = options?.exact === true;
  const m = resolveMessage(g, options?.message, options?.useTypeMsg === true);
  if (g.ctx.mode === "lean") {
    if (exact) {
      g.ctx.usedHelpers.add("__zcTSx");
      return pushIssue(
        g,
        `__zcTSx(${minimum},${escapeString(origin)},${input},${path}${messageArg(m)})`,
      );
    }
    g.ctx.usedHelpers.add("__zcTS");
    return pushIssue(
      g,
      `__zcTS(${minimum},${escapeString(origin)},${inclusive},${input},${path}${messageArg(m)})`,
    );
  }
  if (exact) {
    return pushIssue(
      g,
      `{code:"too_small",minimum:${minimum},origin:${escapeString(origin)},inclusive:true,exact:true${messageProp(m)},input:${input},path:${path}}`,
    );
  }
  return pushIssue(
    g,
    `{code:"too_small",minimum:${minimum},origin:${escapeString(origin)},inclusive:${inclusive}${messageProp(m)},input:${input},path:${path}}`,
  );
}

export function tooBig(
  g: IssueGen,
  maximum: string | number,
  origin: string,
  inclusive: boolean,
  options?: {
    exact?: boolean;
    input?: string;
    path?: string;
    message?: string | undefined;
    /** Set for node-level issues (tuple length) where schema error applies. */
    useTypeMsg?: boolean;
  },
): string {
  const input = options?.input ?? g.input;
  const path = options?.path ?? g.path;
  const exact = options?.exact === true;
  const m = resolveMessage(g, options?.message, options?.useTypeMsg === true);
  if (g.ctx.mode === "lean") {
    if (exact) {
      g.ctx.usedHelpers.add("__zcTBx");
      return pushIssue(
        g,
        `__zcTBx(${maximum},${escapeString(origin)},${input},${path}${messageArg(m)})`,
      );
    }
    g.ctx.usedHelpers.add("__zcTB");
    return pushIssue(
      g,
      `__zcTB(${maximum},${escapeString(origin)},${inclusive},${input},${path}${messageArg(m)})`,
    );
  }
  if (exact) {
    return pushIssue(
      g,
      `{code:"too_big",maximum:${maximum},origin:${escapeString(origin)},inclusive:true,exact:true${messageProp(m)},input:${input},path:${path}}`,
    );
  }
  return pushIssue(
    g,
    `{code:"too_big",maximum:${maximum},origin:${escapeString(origin)},inclusive:${inclusive}${messageProp(m)},input:${input},path:${path}}`,
  );
}

export function invalidType(
  g: IssueGen,
  expected: string,
  options?: { input?: string; path?: string; extra?: string; message?: string | undefined },
): string {
  const input = options?.input ?? g.input;
  const path = options?.path ?? g.path;
  // invalid_type is always created by the schema node — schema error applies.
  const m = resolveMessage(g, options?.message, true);
  if (g.ctx.mode === "lean" && !options?.extra) {
    g.ctx.usedHelpers.add("__zcIT");
    return pushIssue(g, `__zcIT(${escapeString(expected)},${input},${path}${messageArg(m)})`);
  }
  const extra = options?.extra ? `,${options.extra}` : "";
  return pushIssue(
    g,
    `{code:"invalid_type",expected:${escapeString(expected)}${extra}${messageProp(m)},input:${input},path:${path}}`,
  );
}

export function invalidFormat(
  g: IssueGen,
  format: string | { expr: string },
  options?: { input?: string; path?: string; extra?: string; message?: string | undefined },
): string {
  const input = options?.input ?? g.input;
  const path = options?.path ?? g.path;
  const formatExpr = typeof format === "string" ? escapeString(format) : format.expr;
  // Format issues are created by check instances — schema error never applies.
  const m = options?.message;
  if (g.ctx.mode === "lean") {
    g.ctx.usedHelpers.add("__zcIF");
    const extraArg = options?.extra ? `,{${options.extra}}` : m !== undefined ? ",undefined" : "";
    return pushIssue(g, `__zcIF(${formatExpr},${input},${path}${extraArg}${messageArg(m)})`);
  }
  const extra = options?.extra ? `,${options.extra}` : "";
  return pushIssue(
    g,
    `{code:"invalid_format",format:${formatExpr}${extra}${messageProp(m)},input:${input},path:${path}}`,
  );
}

export function unrecognizedKeys(
  g: IssueGen,
  keysExpr: string,
  options?: { input?: string; path?: string; message?: string | undefined },
): string {
  const input = options?.input ?? g.input;
  const path = options?.path ?? g.path;
  // unrecognized_keys is created by the object schema node — schema error applies.
  const m = resolveMessage(g, options?.message, true);
  if (g.ctx.mode === "lean") {
    g.ctx.usedHelpers.add("__zcUK");
    return pushIssue(g, `__zcUK(${keysExpr},${input},${path}${messageArg(m)})`);
  }
  return pushIssue(
    g,
    `{code:"unrecognized_keys",keys:${keysExpr}${messageProp(m)},input:${input},path:${path}}`,
  );
}

export function invalidValue(
  g: IssueGen,
  valuesExpr: string,
  options?: {
    input?: string;
    path?: string;
    message?: string | undefined;
    /** Set to false for check-level issues (file mime) where schema error does not apply. */
    useTypeMsg?: boolean;
  },
): string {
  const input = options?.input ?? g.input;
  const path = options?.path ?? g.path;
  // Default: enum/literal invalid_value is created by the schema node.
  const m = resolveMessage(g, options?.message, options?.useTypeMsg !== false);
  if (g.ctx.mode === "lean") {
    g.ctx.usedHelpers.add("__zcIV");
    return pushIssue(g, `__zcIV(${valuesExpr},${input},${path}${messageArg(m)})`);
  }
  return pushIssue(
    g,
    `{code:"invalid_value",values:${valuesExpr}${messageProp(m)},input:${input},path:${path}}`,
  );
}
