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
 * Message resolution mirrors zod's `finalizeIssue`, which consults the error
 * map of the INSTANCE that created the issue first and then the map of the
 * SCHEMA that owns it: a check stamps its owner onto every issue it raises
 * (`attachSchema`), so `z.string({ error: "msg" }).min(3)` reports "msg" for the
 * `too_small` as well as for the `invalid_type`. Every emitter therefore takes
 * the per-check message (options.message, extracted from `.min(3, "msg")`) and
 * falls back to the node's schema-level message (g.typeMsg, from
 * `z.string({ error: "msg" })`), which is scoped to the node being generated and
 * never inherited by a child node's issues. When no message lands, the __zcFin
 * finalizer applies the locale default.
 *
 * KEY ORDER MATTERS, and is reproduced from zod issue by issue. `ZodError`
 * builds its `message` as `JSON.stringify(issues, …, 2)`, so insertion order is
 * printed text in a property consumers log, snapshot and serialize — an issue
 * carrying the right fields in the wrong order still renders a different error.
 * zod's own orders are irregular (`too_small` leads with `origin` from a check
 * but with `code` from a tuple's length branch; `invalid_format` carries
 * `origin` for a pattern check and omits it for `z.url()`), so each emitter
 * below mirrors one `payload.issues.push({…})` rather than a house style.
 *
 * `message` is written LAST everywhere, after `path`: zod never puts it in the
 * literal — `finalizeIssue` assigns `full.message` afterwards — and that holds
 * for a baked custom message too, since the custom error map is consulted from
 * inside that same assignment.
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

/** Resolve the effective static message for an issue site: the check's own message, else the owning schema's. */
function resolveMessage(g: IssueGen, explicit: string | undefined): string | undefined {
  return explicit ?? g.typeMsg;
}

/** `,message:"..."` fragment for inline object literals ("" when no message). */
/**
 * `,continue:false` — the marker that makes an issue ABORT its union option.
 *
 * zod prunes union options with `util.aborted`, which asks whether any issue has
 * `continue !== true`. Compiled issues carry no `continue` at all, so the union
 * generator classifies by CODE instead — sound for every issue a schema node
 * raises (`invalid_type`, `unrecognized_keys`, …) but blind to the one
 * exception: `$ZodTuple`'s length branch pushes a `too_small`/`too_big` from the
 * NODE, with no `continue`, where the identically-coded issue from an
 * `.min()`/`.max()` CHECK carries `continue: true` and does not abort. Without
 * this, `z.union([z.tuple([a, b]), z.number()])` handed `[]` surfaced the
 * tuple's `too_small` directly instead of wrapping both options in an
 * `invalid_union`.
 *
 * Stripped during finalization exactly as zod strips its own (`delete
 * full.continue`), so it never reaches a reported issue — see FAIL_CLASS_DECL
 * and ZC_FZ_DECL.
 */
function abortsProp(aborts: boolean | undefined): string {
  return aborts === true ? ",continue:false" : "";
}

function messageProp(m: string | undefined): string {
  return m === undefined ? "" : `,message:${escapeString(m)}`;
}

/** `,"..."` trailing argument fragment for lean factory calls ("" when no message). */
function messageArg(m: string | undefined): string {
  return m === undefined ? "" : `,${escapeString(m)}`;
}

/**
 * `origin` as source: a bare string is a literal (`"string"`), `{ expr }` is an
 * expression evaluated at runtime — what a `when`-gated length/size check needs,
 * since zod derives its origin from the INPUT (`getLengthableOrigin`).
 */
type Origin = string | { expr: string };

function originExpr(origin: Origin): string {
  return typeof origin === "string" ? escapeString(origin) : origin.expr;
}

export function tooSmall(
  g: IssueGen,
  minimum: string | number,
  origin: Origin,
  inclusive: boolean,
  options?: {
    exact?: boolean;
    input?: string;
    path?: string;
    message?: string | undefined;
    /**
     * `"tuple"` selects $ZodTuple's under-length key order — `code, minimum,
     * inclusive, origin` — where a check-created size issue leads with `origin`.
     * Same shape as its over-length sibling in {@link tooBig}.
     */
    layout?: "tuple";
    /** Emit the union-abort marker; see {@link abortsProp}. */
    aborts?: boolean;
  },
): string {
  const input = options?.input ?? g.input;
  const path = options?.path ?? g.path;
  const exact = options?.exact === true;
  const m = resolveMessage(g, options?.message);
  if (g.ctx.mode === "lean") {
    if (exact) {
      g.ctx.usedHelpers.add("__zcTSx");
      return pushIssue(
        g,
        `__zcTSx(${minimum},${originExpr(origin)},${input},${path}${messageArg(m)})`,
      );
    }
    if (options?.layout === "tuple") {
      g.ctx.usedHelpers.add("__zcTSt");
      return pushIssue(
        g,
        `__zcTSt(${minimum},${originExpr(origin)},${input},${path}${messageArg(m)})`,
      );
    }
    g.ctx.usedHelpers.add("__zcTS");
    return pushIssue(
      g,
      `__zcTS(${minimum},${originExpr(origin)},${inclusive},${input},${path}${messageArg(m)})`,
    );
  }
  if (exact) {
    return pushIssue(
      g,
      `{origin:${originExpr(origin)},code:"too_small",minimum:${minimum},inclusive:true,exact:true,input:${input},path:${path}${messageProp(m)}}`,
    );
  }
  if (options?.layout === "tuple") {
    return pushIssue(
      g,
      `{code:"too_small",minimum:${minimum},inclusive:${inclusive},origin:${originExpr(origin)},input:${input},path:${path}${messageProp(m)}${abortsProp(options?.aborts)}}`,
    );
  }
  return pushIssue(
    g,
    `{origin:${originExpr(origin)},code:"too_small",minimum:${minimum},inclusive:${inclusive},input:${input},path:${path}${messageProp(m)}}`,
  );
}

export function tooBig(
  g: IssueGen,
  maximum: string | number,
  origin: Origin,
  inclusive: boolean,
  options?: {
    exact?: boolean;
    input?: string;
    path?: string;
    message?: string | undefined;
    /**
     * `"tuple"` selects $ZodTuple's over-length key order — `code, maximum,
     * inclusive, origin` — where a check-created size issue leads with `origin`.
     * zod builds the tuple issue by spreading `{code, maximum, inclusive}` and
     * appending `origin` after `input`/`inst`, and that ordering is visible in
     * `ZodError.message`.
     */
    layout?: "tuple";
    /** Emit the union-abort marker; see {@link abortsProp}. */
    aborts?: boolean;
  },
): string {
  const input = options?.input ?? g.input;
  const path = options?.path ?? g.path;
  const exact = options?.exact === true;
  const m = resolveMessage(g, options?.message);
  if (g.ctx.mode === "lean") {
    if (exact) {
      g.ctx.usedHelpers.add("__zcTBx");
      return pushIssue(
        g,
        `__zcTBx(${maximum},${originExpr(origin)},${input},${path}${messageArg(m)})`,
      );
    }
    if (options?.layout === "tuple") {
      g.ctx.usedHelpers.add("__zcTBt");
      return pushIssue(
        g,
        `__zcTBt(${maximum},${originExpr(origin)},${input},${path}${messageArg(m)})`,
      );
    }
    g.ctx.usedHelpers.add("__zcTB");
    return pushIssue(
      g,
      `__zcTB(${maximum},${originExpr(origin)},${inclusive},${input},${path}${messageArg(m)})`,
    );
  }
  if (exact) {
    return pushIssue(
      g,
      `{origin:${originExpr(origin)},code:"too_big",maximum:${maximum},inclusive:true,exact:true,input:${input},path:${path}${messageProp(m)}}`,
    );
  }
  if (options?.layout === "tuple") {
    return pushIssue(
      g,
      `{code:"too_big",maximum:${maximum},inclusive:${inclusive},origin:${originExpr(origin)},input:${input},path:${path}${messageProp(m)}${abortsProp(options?.aborts)}}`,
    );
  }
  return pushIssue(
    g,
    `{origin:${originExpr(origin)},code:"too_big",maximum:${maximum},inclusive:${inclusive},input:${input},path:${path}${messageProp(m)}}`,
  );
}

export function invalidType(
  g: IssueGen,
  expected: string,
  options?: {
    input?: string;
    path?: string;
    extra?: string;
    message?: string | undefined;
    /**
     * Put `extra` BEFORE `code` rather than after it. $ZodCheckNumberFormat's
     * non-integer issue is `{expected, format, code}` while the `received` a
     * number/date schema adds trails `code` — two orders for one issue code, both
     * printed verbatim in `ZodError.message`.
     */
    extraBeforeCode?: boolean;
    /**
     * Lead with `code` instead of `expected`. `$ZodDiscriminatedUnion`'s
     * non-object guard and `$ZodObject`'s absent-required-key issue
     * (`expected: "nonoptional"`) write the issue that way; every other schema
     * in zod puts `expected` first.
     */
    codeFirst?: boolean;
    /**
     * Set to false for the one `invalid_type` zod pushes WITHOUT an `inst`:
     * the object's `nonoptional` issue for an absent required key, which no
     * schema-level `error` reaches.
     */
    useTypeMsg?: boolean;
  },
): string {
  const input = options?.input ?? g.input;
  const path = options?.path ?? g.path;
  // The schema's own message applies unless the issue is raised inst-less, as the nonoptional issue is.
  const m = options?.useTypeMsg === false ? options?.message : resolveMessage(g, options?.message);
  if (g.ctx.mode === "lean" && !options?.extra) {
    const helper = options?.codeFirst ? "__zcITc" : "__zcIT";
    g.ctx.usedHelpers.add(helper);
    return pushIssue(g, `${helper}(${escapeString(expected)},${input},${path}${messageArg(m)})`);
  }
  const extra = options?.extra ?? "";
  const head = options?.codeFirst
    ? `code:"invalid_type",expected:${escapeString(expected)}${extra ? `,${extra}` : ""}`
    : options?.extraBeforeCode
      ? `expected:${escapeString(expected)}${extra ? `,${extra}` : ""},code:"invalid_type"`
      : `expected:${escapeString(expected)},code:"invalid_type"${extra ? `,${extra}` : ""}`;
  return pushIssue(g, `{${head},input:${input},path:${path}${messageProp(m)}}`);
}

export function invalidFormat(
  g: IssueGen,
  format: string | { expr: string },
  options?: {
    input?: string;
    path?: string;
    /**
     * Leading `origin`, present only where zod's push carries one:
     * `$ZodCheckStringFormat`'s default pattern check and the regex / includes /
     * starts_with / ends_with checks lead with `origin: "string"`, while
     * `z.url()`'s own issues and every `$ZodCustomStringFormat` omit it.
     */
    origin?: string | undefined;
    /**
     * Extra issue properties as a source fragment (`'pattern:"…"'`), emitted
     * right after `format` where zod writes them. Explicitly `| undefined` so a
     * caller can compute it conditionally: zod's `invalid_format` carries
     * different fields per format, and the bare-issue formats carry none.
     */
    extra?: string | undefined;
    message?: string | undefined;
  },
): string {
  const input = options?.input ?? g.input;
  const path = options?.path ?? g.path;
  const formatExpr = typeof format === "string" ? escapeString(format) : format.expr;
  const m = resolveMessage(g, options?.message);
  if (g.ctx.mode === "lean") {
    g.ctx.usedHelpers.add("__zcIF");
    const originArg = options?.origin === undefined ? "undefined" : escapeString(options.origin);
    const extraArg = options?.extra ? `,{${options.extra}}` : m !== undefined ? ",undefined" : "";
    return pushIssue(
      g,
      `__zcIF(${originArg},${formatExpr},${input},${path}${extraArg}${messageArg(m)})`,
    );
  }
  const originProp = options?.origin === undefined ? "" : `origin:${escapeString(options.origin)},`;
  const extra = options?.extra ? `,${options.extra}` : "";
  return pushIssue(
    g,
    `{${originProp}code:"invalid_format",format:${formatExpr}${extra},input:${input},path:${path}${messageProp(m)}}`,
  );
}

export function unrecognizedKeys(
  g: IssueGen,
  keysExpr: string,
  options?: { input?: string; path?: string; message?: string | undefined },
): string {
  const input = options?.input ?? g.input;
  const path = options?.path ?? g.path;
  const m = resolveMessage(g, options?.message);
  if (g.ctx.mode === "lean") {
    g.ctx.usedHelpers.add("__zcUK");
    return pushIssue(g, `__zcUK(${keysExpr},${input},${path}${messageArg(m)})`);
  }
  return pushIssue(
    g,
    `{code:"unrecognized_keys",keys:${keysExpr},input:${input},path:${path}${messageProp(m)}}`,
  );
}

export function invalidValue(
  g: IssueGen,
  valuesExpr: string,
  options?: {
    input?: string;
    path?: string;
    /**
     * Extra issue properties as a source fragment (`'expected:"stringbool"'`),
     * modelled on {@link invalidFormat}'s option of the same name. Explicitly
     * `| undefined` so a caller can compute it conditionally: the `invalid_value`
     * producers do NOT agree on fields — enum and literal push only `values`,
     * while z.stringbool()'s codec transform also pushes
     * `expected: "stringbool"`, which zod's locale reads to phrase the message.
     */
    extra?: string | undefined;
    message?: string | undefined;
  },
): string {
  const input = options?.input ?? g.input;
  const path = options?.path ?? g.path;
  const m = resolveMessage(g, options?.message);
  if (g.ctx.mode === "lean") {
    g.ctx.usedHelpers.add("__zcIV");
    const extraArg = options?.extra ? `,{${options.extra}}` : m !== undefined ? ",undefined" : "";
    return pushIssue(g, `__zcIV(${valuesExpr},${input},${path}${extraArg}${messageArg(m)})`);
  }
  // `expected` precedes `values` in z.stringbool()'s push, so extras go between
  // `code` and `values` rather than after them.
  const extra = options?.extra ? `,${options.extra}` : "";
  return pushIssue(
    g,
    `{code:"invalid_value"${extra},values:${valuesExpr},input:${input},path:${path}${messageProp(m)}}`,
  );
}
