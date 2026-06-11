import type { AnyNode, Expression, Options } from "acorn";
import { Parser } from "acorn";
import { applyEdits, type Edit, type Insertion } from "./edits.js";

/**
 * Hoist Zod schema construction out of functions to module scope —
 * equivalent of babel-plugin-zod-hoist.
 *
 * Schemas built inside function bodies are re-constructed on every call:
 *
 *   function getSchema() {
 *     return z.object({ name: z.string() });   // rebuilt per call
 *   }
 *
 * becomes
 *
 *   const _zh_94b7f5c1 = z.object({ name: z.string() });
 *   function getSchema() {
 *     return _zh_94b7f5c1;                      // built once
 *   }
 *
 * Safety rules (babel-plugin-zod-hoist's `canSafelyHoist`, hardened for
 * lexical analysis):
 * - A free identifier must be an import or a KNOWN_GLOBALS member, and must
 *   never be bound anywhere in the file (function params, locals, catch
 *   clauses, class names, module-level const/let/var — hoisting above those
 *   would change meaning or hit the TDZ). The babel plugin additionally
 *   allows arbitrary unbound identifiers because it has real scope
 *   information; this port's binding collector is lexical, so an unknown
 *   bare name is treated as a possibly-missed binding rather than a global
 *   (a wrong guess crashes at module load with a ReferenceError).
 *   `this`/`super` disqualify anywhere. Eager `await`/`yield` also
 *   disqualify (stricter than the babel plugin, which never encounters
 *   them: hoisting one would emit top-level await / orphaned yield).
 * - Eligible roots: any binding imported from zod, an imported identifier
 *   matching /ZodSchema$/, or an imported identifier whose chain contains
 *   an inline z.* reference (e.g. `Base.extend({ a: z.string() })`).
 * - Nesting (babel's `isNestedInZodCall`): the interior of a zod-rooted
 *   chain never hoists separately — it goes with the outer schema or not at
 *   all. Chains rooted elsewhere (`sql.type(...)`, `api.get(...)`) do NOT
 *   suppress their arguments: when the outer chain is rejected, an inner
 *   `z.object({...})` still hoists on its own.
 * - Declarations are inserted at the top of the module (after shebang and
 *   directive prologue). Imports are initialized before module code runs,
 *   so referencing them from above their textual position is safe.
 * - Names are content-hashed, so identical schemas dedupe to one binding.
 *
 * The source is TypeScript, which acorn cannot fully parse — candidates are
 * located with a string/comment/depth-aware scanner and extracted with
 * parseExpressionAt (the same technique as the autoDiscover rewrite).
 * Anything unparseable (TS generics, `as` casts) is skipped: a miss leaves
 * the schema unhoisted, never breaks the code.
 */

/** Imported identifiers matching this pattern are treated as schema roots. */
const SCHEMA_NAME_PATTERN = /ZodSchema$/;

/** Module specifiers whose bindings count as the zod namespace. */
const ZOD_MODULES = new Set(["zod", "zod/v4", "zod/mini", "zod/v4/mini"]);

/** How an imported local binding maps onto its source module. */
export interface ImportDetail {
  /** Module specifier (`"zod"`, `"./shapes"`). */
  specifier: string;
  /** Exported name the binding refers to; `"*"` for namespace imports, `"default"` for default imports. */
  imported: string;
}

interface ImportBindings {
  /** Every runtime (non-type) imported binding name. */
  all: Set<string>;
  /** Bindings imported from a zod module (usually just `z`). */
  zod: Set<string>;
  /** Local binding name → source module/export, for build-time evaluation. */
  details: Map<string, ImportDetail>;
}

/**
 * Collect runtime import bindings with a regex over import statements.
 * Type-only imports and `type` specifiers are excluded — they cannot be
 * referenced at runtime, so excluding them keeps the capture rule sound.
 */
export function collectImportBindings(code: string): ImportBindings {
  const all = new Set<string>();
  const zod = new Set<string>();
  const details = new Map<string, ImportDetail>();
  const importPattern = /import\s+(type\s+)?([^'";]+?)\s+from\s*["']([^"']+)["']/g;

  for (const match of code.matchAll(importPattern)) {
    const [, typeOnly, clause, specifier] = match;
    if (typeOnly || clause === undefined || specifier === undefined) continue;
    const isZod = ZOD_MODULES.has(specifier);
    for (const { local, imported } of parseImportClause(clause)) {
      all.add(local);
      if (isZod) zod.add(local);
      details.set(local, { specifier, imported });
    }
  }
  return { all, zod, details };
}

/** Extract local binding names (with their source export) from an import clause. */
function parseImportClause(clause: string): Array<{ local: string; imported: string }> {
  const names: Array<{ local: string; imported: string }> = [];
  const namedStart = clause.indexOf("{");

  // Default import and/or namespace import before the named group
  const head = namedStart === -1 ? clause : clause.slice(0, namedStart);
  for (const part of head.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const ns = trimmed.match(/^\*\s*as\s+([A-Za-z_$][\w$]*)$/);
    if (ns?.[1]) {
      names.push({ local: ns[1], imported: "*" });
    } else if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
      names.push({ local: trimmed, imported: "default" });
    }
  }

  if (namedStart !== -1) {
    const namedEnd = clause.indexOf("}", namedStart);
    const inner = clause.slice(namedStart + 1, namedEnd === -1 ? undefined : namedEnd);
    for (const part of inner.split(",")) {
      const spec = part.trim();
      if (!spec || spec.startsWith("type ")) continue;
      // `a as b` binds b; plain `a` binds a
      const asMatch = spec.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (asMatch?.[1] && asMatch[2]) {
        names.push({ local: asMatch[2], imported: asMatch[1] });
      } else if (/^[A-Za-z_$][\w$]*$/.test(spec)) {
        names.push({ local: spec, imported: spec });
      }
    }
  }
  return names;
}

/** Deterministic FNV-1a 32-bit hash, hex-encoded. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

interface Candidate {
  /** Offset of the root identifier. */
  index: number;
  /** Bracket/brace/paren depth at the offset (0 = top level). */
  depth: number;
  /** The root identifier text. */
  name: string;
  /**
   * The candidate directly follows `=>` — a concise arrow body. Even at
   * depth 0 (`const make = () => z.object(...)`) it re-evaluates per call.
   */
  afterArrow: boolean;
}

/**
 * Char-code identifier/whitespace classes for the scanner hot loops — a
 * regex `.test()` per character dominated scan time once the acorn parses
 * were gone. The ident classes are deliberately ASCII-only (`[A-Za-z_$]` /
 * `[\w$]`, matching the scanner's historical regexes); the space check falls
 * back to `/\s/` for the rare non-ASCII code points it matches (NBSP, BOM,
 * U+2028...).
 */
function isIdentStartCode(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36;
}
function isIdentPartCode(c: number): boolean {
  return (
    (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36
  );
}
function isSpaceCode(c: number): boolean {
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  return c > 127 && /\s/.test(String.fromCharCode(c));
}

/** After these tokens a `/` starts a regex literal, not division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "do",
  "else",
  "case",
  "yield",
  "await",
]);

/** Is `/` after this token division (true) or a regex literal (false)? */
function isDivisionContext(lastToken: string): boolean {
  if (lastToken === ")" || lastToken === "]") return true;
  if (/^["'`]$/.test(lastToken)) return true;
  if (/^[\w$]+$/.test(lastToken)) return !REGEX_PRECEDING_KEYWORDS.has(lastToken);
  return false;
}

interface ScanResult {
  candidates: Candidate[];
  /**
   * Lazily builds the source with comments, string/template-string contents,
   * and regex literals masked to spaces (offsets preserved). Used for
   * binding-name collection so JSDoc examples and string contents never
   * count. Lazy because it is only needed when a candidate survives to
   * shadow-checking — schema modules (everything masked at depth 0) never
   * pay for it.
   */
  stripped: () => string;
}

/**
 * Scan the source for candidate root identifiers (`z`, `FooZodSchema`, ...)
 * followed by a `.`, tracking string/template/comment state and nesting
 * depth. Depth 0 candidates are top-level initializers — already evaluated
 * once — and are recorded only so their extents mask nested candidates.
 */
function scanSource(code: string, roots: Set<string>): ScanResult {
  const candidates: Candidate[] = [];
  // Masked extents as flat [from, to) pairs, pushed in scan order (monotonic,
  // non-overlapping) — materialized into a stripped string only on demand.
  const maskRanges: number[] = [];
  const mask = (from: number, to: number): void => {
    maskRanges.push(from, to);
  };
  let depth = 0;
  // Template literals interleave string and expression states; the stack
  // records the brace depth at which each `${` opened so the matching `}`
  // resumes string state.
  const templateStack: number[] = [];
  let lastToken = "";
  let i = 0;

  while (i < code.length) {
    const ch = code[i] as string;
    const next = code[i + 1];

    // Comments
    if (ch === "/" && next === "/") {
      const nl = code.indexOf("\n", i);
      const end = nl === -1 ? code.length : nl + 1;
      mask(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = code.indexOf("*/", i + 2);
      const end = close === -1 ? code.length : close + 2;
      mask(i, end);
      i = end;
      continue;
    }
    if (ch === "/") {
      if (!isDivisionContext(lastToken)) {
        const end = skipRegexLiteral(code, i);
        mask(i, end);
        i = end;
        lastToken = ")"; // a regex literal is an operand
        continue;
      }
      lastToken = ch;
      i++;
      continue;
    }
    // Strings
    if (ch === '"' || ch === "'") {
      const end = skipString(code, i, ch);
      mask(i, end);
      i = end;
      lastToken = ch;
      continue;
    }
    // Template literals
    if (ch === "`") {
      const end = skipTemplateChunk(code, i + 1, templateStack, depth);
      mask(i, end);
      i = end;
      lastToken = "`";
      continue;
    }
    if (
      templateStack.length > 0 &&
      ch === "}" &&
      depth === templateStack[templateStack.length - 1]
    ) {
      // End of a ${ } expression — back into template string state
      templateStack.pop();
      const end = skipTemplateChunk(code, i + 1, templateStack, depth);
      mask(i, end);
      i = end;
      lastToken = "`";
      continue;
    }

    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      lastToken = ch;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      lastToken = ch;
      i++;
      continue;
    }

    if (isIdentStartCode(code.charCodeAt(i)) && !isIdentPartCode(code.charCodeAt(i - 1))) {
      let j = i + 1;
      while (j < code.length && isIdentPartCode(code.charCodeAt(j))) j++;
      const word = code.slice(i, j);
      // Skip whitespace to check for the member access
      let k = j;
      while (k < code.length && isSpaceCode(code.charCodeAt(k))) k++;
      if (roots.has(word) && code[k] === "." && lastToken !== ".") {
        candidates.push({ index: i, depth, name: word, afterArrow: lastToken === "=>" });
      }
      lastToken = word;
      i = j;
      continue;
    }

    if (!isSpaceCode(code.charCodeAt(i))) {
      lastToken = ch === ">" && lastToken === "=" ? "=>" : ch;
    }
    i++;
  }

  const stripped = (): string => {
    if (maskRanges.length === 0) return code;
    let out = "";
    let prev = 0;
    for (let r = 0; r < maskRanges.length; r += 2) {
      const from = maskRanges[r] as number;
      const to = maskRanges[r + 1] as number;
      out += code.slice(prev, from) + code.slice(from, to).replace(/[^\n]/g, " ");
      prev = to;
    }
    return out + code.slice(prev);
  };
  return { candidates, stripped };
}

function skipString(code: string, start: number, quote: string): number {
  for (let i = start + 1; i < code.length; i++) {
    if (code[i] === "\\") {
      i++;
    } else if (code[i] === quote || code[i] === "\n") {
      return i + 1;
    }
  }
  return code.length;
}

/**
 * Skip a template string chunk; returns the offset after the closing
 * `` ` `` or after a `${`, recording the current depth so the scanner can
 * recognize the matching `}` later.
 */
function skipTemplateChunk(
  code: string,
  start: number,
  templateStack: number[],
  depth: number,
): number {
  for (let i = start; i < code.length; i++) {
    if (code[i] === "\\") {
      i++;
    } else if (code[i] === "`") {
      return i + 1;
    } else if (code[i] === "$" && code[i + 1] === "{") {
      templateStack.push(depth);
      return i + 2;
    }
  }
  return code.length;
}

function skipRegexLiteral(code: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < code.length; i++) {
    const ch = code[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "]") {
      inClass = false;
    } else if (ch === "/" && !inClass) {
      return i + 1;
    } else if (ch === "\n") {
      // Not a regex after all (unterminated) — treat as division
      return start + 1;
    }
  }
  return code.length;
}

/**
 * Cheap chain-extent scan: from a root identifier, advance past the longest
 * member/call/tagged-template chain (`.x`, `?.x`, `!`, `(...)`, `[...]`,
 * `` `...` ``). Used to mask the interior of depth-0 chains WITHOUT an acorn
 * parse: schema modules are mostly top-level declarations, and parsing each
 * one only to discard it under the depth-0 rule dominated cold hoist cost in
 * a field report (hoist 37–46s vs discover 12–16s across ~7k transforms).
 * May overshoot an AST-exact end only across TS-only syntax (postfix `!`);
 * stops at anything else it does not recognize (`<` generics, operators) —
 * an undershoot leaves interior candidates to their own depth-0/eligibility
 * rules, an overshoot only widens the mask over an expression that already
 * evaluates once at module scope.
 */
function findChainEnd(code: string, identStart: number): number {
  let i = identStart;
  while (i < code.length && isIdentPartCode(code.charCodeAt(i))) i++;

  const skipTrivia = (): void => {
    for (;;) {
      while (i < code.length && isSpaceCode(code.charCodeAt(i))) i++;
      if (code[i] === "/" && code[i + 1] === "/") {
        const nl = code.indexOf("\n", i);
        i = nl === -1 ? code.length : nl + 1;
      } else if (code[i] === "/" && code[i + 1] === "*") {
        const close = code.indexOf("*/", i + 2);
        i = close === -1 ? code.length : close + 2;
      } else {
        return;
      }
    }
  };

  // Advance past one balanced construct starting at `(`, `[`, or a template
  // backtick — mirroring scanSource's string/template/regex/comment rules.
  const skipNested = (): void => {
    let depth = 0;
    const templateStack: number[] = [];
    let lastToken = "";
    while (i < code.length) {
      const ch = code[i] as string;
      const next = code[i + 1];
      if (ch === "/" && next === "/") {
        const nl = code.indexOf("\n", i);
        i = nl === -1 ? code.length : nl + 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        const close = code.indexOf("*/", i + 2);
        i = close === -1 ? code.length : close + 2;
        continue;
      }
      if (ch === "/") {
        if (!isDivisionContext(lastToken)) {
          i = skipRegexLiteral(code, i);
          lastToken = ")";
          continue;
        }
        lastToken = ch;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        i = skipString(code, i, ch);
        lastToken = ch;
        continue;
      }
      if (ch === "`") {
        i = skipTemplateChunk(code, i + 1, templateStack, depth);
        lastToken = "`";
        if (depth === 0 && templateStack.length === 0) return;
        continue;
      }
      if (
        templateStack.length > 0 &&
        ch === "}" &&
        depth === templateStack[templateStack.length - 1]
      ) {
        templateStack.pop();
        i = skipTemplateChunk(code, i + 1, templateStack, depth);
        lastToken = "`";
        if (depth === 0 && templateStack.length === 0) return;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
        lastToken = ch;
        i++;
        continue;
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        lastToken = ch;
        i++;
        if (depth === 0 && templateStack.length === 0) return;
        continue;
      }
      if (isIdentStartCode(code.charCodeAt(i)) && !isIdentPartCode(code.charCodeAt(i - 1))) {
        let j = i + 1;
        while (j < code.length && isIdentPartCode(code.charCodeAt(j))) j++;
        lastToken = code.slice(i, j);
        i = j;
        continue;
      }
      if (!isSpaceCode(code.charCodeAt(i))) {
        lastToken = ch === ">" && lastToken === "=" ? "=>" : ch;
      }
      i++;
    }
  };

  for (;;) {
    skipTrivia();
    const ch = code[i];
    if (ch === "." || (ch === "?" && code[i + 1] === ".")) {
      i += ch === "." ? 1 : 2;
      skipTrivia();
      while (i < code.length && isIdentPartCode(code.charCodeAt(i))) i++;
      continue;
    }
    if (ch === "!") {
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "`") {
      skipNested();
      continue;
    }
    return i;
  }
}

/**
 * Parse a single assignment-level expression at `pos` — the same entry point
 * acorn's own parseExpressionAt uses, one precedence level down. At
 * expression level a trailing comma in an argument position
 * (`sql.type(z.object({...}),\n)`) starts a sequence-expression parse that
 * throws on the surrounding `)`; assignment level treats the comma as
 * trailing garbage and stops cleanly. parseMaybeAssign is the entry point
 * the acorn plugin ecosystem overrides — stable across versions.
 */
function parseAssignmentAt(code: string, pos: number): Expression {
  interface ParserInternals {
    nextToken(): void;
    parseMaybeAssign(): Expression;
  }
  const parser = new (Parser as unknown as new (
    options: Options,
    input: string,
    startPos?: number,
  ) => ParserInternals)({ ecmaVersion: "latest", sourceType: "module" }, code, pos);
  parser.nextToken();
  return parser.parseMaybeAssign();
}

/**
 * Narrow a parsed expression to the largest call chain starting at `start`.
 * The parse can overshoot into surrounding operators
 * (`z.string().min(1) || fallback` parses as a LogicalExpression) — descend
 * through same-start children until a CallExpression is found.
 */
function narrowToCallChain(node: Expression, start: number): Expression | null {
  let current: AnyNode = node;
  while (current.start === start) {
    if (current.type === "CallExpression") return current as Expression;
    const child = sameStartChild(current, start);
    if (!child) return null;
    current = child;
  }
  return null;
}

function sameStartChild(node: AnyNode, start: number): AnyNode | null {
  const record = node as unknown as Record<string, unknown>;
  for (const key of ["left", "object", "callee", "test", "tag", "expression", "expressions"]) {
    const value = record[key];
    const child = Array.isArray(value) ? value[0] : value;
    if (
      typeof child === "object" &&
      child !== null &&
      (child as AnyNode).start === start &&
      typeof (child as AnyNode).type === "string"
    ) {
      return child as AnyNode;
    }
  }
  return null;
}

/**
 * Walk a member/call chain down to its base identifier, collecting the
 * non-computed method names along the spine. Computed members
 * (`base[name]()`) are unanalyzable — the chain is rejected.
 */
function describeChain(node: Expression): { root: string; methods: string[] } | null {
  const methods: string[] = [];
  let current: AnyNode = node;
  while (true) {
    if (current.type === "CallExpression") {
      current = current.callee;
    } else if (current.type === "MemberExpression") {
      if (current.computed || current.property.type !== "Identifier") return null;
      methods.push(current.property.name);
      current = current.object;
    } else if (current.type === "Identifier") {
      return { root: current.name, methods };
    } else {
      return null;
    }
  }
}

/**
 * Combinators eligible on non-z chain bases (babel-plugin-zod-hoist's
 * SCHEMA_COMBINATOR_METHODS, verbatim) — `Base.extend({...})`,
 * `Base.pick({...})`, `UserZodSchema.optional()`, ...
 */
const COMBINATOR_METHODS = new Set([
  "and",
  "array",
  "brand",
  "catchall",
  "deepPartial",
  "describe",
  "extend",
  "merge",
  "nullable",
  "nullish",
  "omit",
  "optional",
  "or",
  "partial",
  "passthrough",
  "pick",
  "readonly",
  "refine",
  "required",
  "strict",
  "strip",
  "superRefine",
  "transform",
]);

/**
 * Methods that evaluate data rather than construct schemas. Hoisting one
 * would move the evaluation (and any throw) to module load.
 */
const PARSE_METHODS = new Set([
  "parse",
  "safeParse",
  "parseAsync",
  "safeParseAsync",
  "decode",
  "encode",
  "decodeAsync",
  "encodeAsync",
]);

/**
 * Standard globals a hoisted expression may reference (eager or deferred —
 * babel-parity behaviors like hoisting `z.date().default(new Date())` rely
 * on Date/Math being recognized).
 *
 * The babel plugin allows ANY unbound identifier because it has real scope
 * information; this port's binding collector is a lexical approximation, so
 * an unknown bare name must be assumed to be a binding the collector missed
 * — hoisting it would crash at module load with
 * `ReferenceError: <name> is not defined`. A fixed allowlist converts that
 * failure mode into a missed optimization.
 */
const KNOWN_GLOBALS = new Set([
  "globalThis",
  "NaN",
  "Infinity",
  "Math",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "JSON",
  "Date",
  "RegExp",
  "BigInt",
  "Symbol",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Proxy",
  "Reflect",
  "Intl",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "ArrayBuffer",
  "Uint8Array",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURI",
  "decodeURI",
  "encodeURIComponent",
  "decodeURIComponent",
  "structuredClone",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "atob",
  "btoa",
  "crypto",
  "console",
  "process",
  "Buffer",
]);

interface CaptureAnalysis {
  /** Free identifiers referenced in eager (immediately evaluated) positions. */
  eagerFree: Set<string>;
  /** Free identifiers referenced only inside nested function bodies. */
  deferredFree: Set<string>;
  /** Disqualifying constructs (`this`/`super` anywhere; `await`/`yield` in eager positions). */
  impure: boolean;
}

/**
 * Scope-aware free-variable analysis of an expression. Nested function
 * params and local declarations are bound names, not captures — so
 * `z.string().refine((v) => v.length > 0)` has no free variables beyond `z`.
 * References inside nested function bodies are tracked separately: they
 * evaluate per call even after hoisting, so safe globals are allowed there.
 */
function analyzeCaptures(expr: Expression): CaptureAnalysis {
  const eagerFree = new Set<string>();
  const deferredFree = new Set<string>();
  let impure = false;

  function patternNames(node: AnyNode, into: Set<string>): void {
    switch (node.type) {
      case "Identifier":
        into.add(node.name);
        return;
      case "ObjectPattern":
        for (const prop of node.properties) {
          if (prop.type === "Property") patternNames(prop.value, into);
          else patternNames(prop.argument, into);
        }
        return;
      case "ArrayPattern":
        for (const el of node.elements) {
          if (el) patternNames(el, into);
        }
        return;
      case "AssignmentPattern":
        patternNames(node.left, into);
        return;
      case "RestElement":
        patternNames(node.argument, into);
        return;
      default:
        return;
    }
  }

  function collectFunctionScope(body: AnyNode, into: Set<string>): void {
    // Flatten block scoping into the function scope — over-approximating
    // bound names can only suppress a hoist's free set, and the failure
    // mode is a loud ReferenceError, never silent misvalidation.
    const stack: AnyNode[] = [body];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (node.type === "VariableDeclaration") {
        for (const decl of node.declarations) patternNames(decl.id, into);
      } else if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
        if (node.id) into.add(node.id.name);
        continue; // do not descend into nested declarations' bodies here
      } else if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
        continue; // nested functions get their own scope in visit()
      }
      for (const value of Object.values(node as unknown as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === "object" && item !== null && "type" in item) {
              stack.push(item as AnyNode);
            }
          }
        } else if (typeof value === "object" && value !== null && "type" in value) {
          stack.push(value as AnyNode);
        }
      }
    }
  }

  function visit(node: AnyNode, scopes: Set<string>[], deferred: boolean): void {
    switch (node.type) {
      case "Identifier": {
        const name = node.name;
        if (name !== "undefined" && !scopes.some((s) => s.has(name))) {
          (deferred ? deferredFree : eagerFree).add(name);
        }
        return;
      }
      case "ThisExpression":
      case "Super":
        // Arrows bind `this` lexically — hoisting changes it even when the
        // reference sits inside a callback. Always disqualifying.
        impure = true;
        return;
      case "AwaitExpression":
      case "YieldExpression":
        // Eager occurrences cannot be moved to module scope: hoisting would
        // emit top-level await (broken in CJS output) or an orphaned yield.
        // (Stricter than the babel plugin, whose suite never exercises
        // these.) Deferred occurrences run per call — fine to move.
        if (!deferred) {
          impure = true;
          return;
        }
        break;
      case "MemberExpression":
        visit(node.object, scopes, deferred);
        if (node.computed) visit(node.property, scopes, deferred);
        return;
      case "Property":
        if (node.computed) visit(node.key, scopes, deferred);
        visit(node.value, scopes, deferred);
        return;
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const scope = new Set<string>();
        for (const param of node.params) patternNames(param, scope);
        if (node.type === "FunctionExpression" && node.id) scope.add(node.id.name);
        collectFunctionScope(node.body, scope);
        visit(node.body, [...scopes, scope], true);
        return;
      }
      default:
        break;
    }
    for (const value of Object.values(node as unknown as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "object" && item !== null && "type" in item) {
            visit(item as AnyNode, scopes, deferred);
          }
        }
      } else if (typeof value === "object" && value !== null && "type" in value) {
        visit(value as AnyNode, scopes, deferred);
      }
    }
  }

  visit(expr, [], false);
  return { eagerFree, deferredFree, impure };
}

/** Offset after the shebang and directive prologue ("use client", ...). */
function insertionOffset(code: string): number {
  let i = 0;
  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n");
    i = nl === -1 ? code.length : nl + 1;
  }
  while (true) {
    // Skip whitespace and comments between directives
    while (i < code.length) {
      const ch = code[i] as string;
      if (/\s/.test(ch)) {
        i++;
      } else if (ch === "/" && code[i + 1] === "/") {
        const nl = code.indexOf("\n", i);
        i = nl === -1 ? code.length : nl + 1;
      } else if (ch === "/" && code[i + 1] === "*") {
        const end = code.indexOf("*/", i + 2);
        i = end === -1 ? code.length : end + 2;
      } else {
        break;
      }
    }
    const directive = code.slice(i).match(/^(["'])use [^"'\n]*\1\s*;?[^\S\n]*\n?/);
    if (!directive) return i;
    i += directive[0].length;
  }
}

/** Keywords that precede `( ... ) {` without binding anything. */
const NON_BINDING_KEYWORDS =
  "if|for|while|switch|return|typeof|await|yield|new|do|else|case|in|of|delete|void";

/**
 * Conservative shadow detection: collect every identifier appearing in a
 * binding-like position — function/method/arrow parameter lists, catch
 * clauses, class names, const/let/var declarator patterns. The scanner has
 * no scope information, so an import referenced from a hoisted expression
 * must resolve to that import everywhere; a name that is ever re-bound
 * cannot be trusted and disqualifies hoists referencing it.
 *
 * Collection is depth-aware and multiline (balanced delimiter scanning, not
 * line-bounded regexes): multiline destructuring declarations and parameter
 * defaults containing calls are real production patterns whose bindings a
 * line-based collector misses — and a missed binding here used to mean a
 * hoist referencing it crashed at module load (`ReferenceError`).
 * Over-collection (type names, destructuring default values, for-of
 * iterables) is deliberate and safe: it can only suppress a hoist.
 */
function collectBoundNames(code: string): Set<string> {
  const bound = new Set<string>();

  // Per top-level-comma piece, keep only the binding side: names before any
  // top-level `:` (type annotation) or `=` (default/initializer). Inside
  // destructuring patterns the `:`/`=` sit at depth > 0, so the whole
  // pattern is collected (renames and default values over-collect — safe).
  const addBindingSegment = (segment: string): void => {
    let depth = 0;
    let pieceStart = 0;
    let cut = -1;
    const flush = (end: number): void => {
      const prefix = segment.slice(pieceStart, cut === -1 ? end : cut);
      for (const id of prefix.matchAll(/[A-Za-z_$][\w$]*/g)) {
        bound.add(id[0]);
      }
      cut = -1;
    };
    for (let i = 0; i < segment.length; i++) {
      const ch = segment[i];
      if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
      } else if (depth === 0 && ch === ",") {
        flush(i);
        pieceStart = i + 1;
      } else if (depth === 0 && cut === -1 && (ch === ":" || ch === "=")) {
        cut = i;
      }
    }
    flush(segment.length);
  };

  /** Balanced `( ... )` span starting at `open` (must point at `(`). */
  const parenSpan = (open: number): { inner: string; end: number } | null => {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      const ch = code[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return { inner: code.slice(open + 1, i), end: i };
      }
    }
    return null;
  };

  // function f(a, b) / function (a = call()) — balanced + multiline
  for (const m of code.matchAll(/\bfunction\b/g)) {
    let i = m.index + m[0].length;
    while (i < code.length && code[i] !== "(" && code[i] !== "{" && code[i] !== ";") i++;
    if (code[i] !== "(") continue;
    const span = parenSpan(i);
    if (span) addBindingSegment(span.inner);
  }
  // (a, b) => / (a = call()): Ret => — balanced params located from the arrow
  for (const m of code.matchAll(/=>/g)) {
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(code[i] as string)) i--;
    if (i < 0) continue;
    let closeAt = -1;
    if (code[i] === ")") {
      closeAt = i;
    } else {
      // Possible return-type annotation between `)` and `=>`:
      // `(a): Promise<T> =>`. Find the nearest `)` whose gap to the arrow
      // looks like a type annotation; give up otherwise (over-approximation
      // elsewhere keeps this safe).
      const before = code.slice(0, m.index);
      const lastClose = before.lastIndexOf(")");
      if (lastClose !== -1 && /^\s*:[^(){};]*$/.test(before.slice(lastClose + 1))) {
        closeAt = lastClose;
      }
    }
    if (closeAt === -1) continue;
    // walk back to the matching `(`
    let depth = 0;
    for (let j = closeAt; j >= 0; j--) {
      const ch = code[j];
      if (ch === ")") depth++;
      else if (ch === "(") {
        depth--;
        if (depth === 0) {
          addBindingSegment(code.slice(j + 1, closeAt));
          break;
        }
      }
    }
  }
  // bare arrow param: a =>
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) {
    bound.add(m[1] ?? "");
  }
  // method(a, b) { / method(a = call()): Ret { — excluding control flow.
  // The balanced span must be directly followed by `{` (after an optional
  // return type), which call expressions essentially never are.
  const methodAnchor = new RegExp(
    String.raw`(?<![.\w$])(?!(?:${NON_BINDING_KEYWORDS})\b)[A-Za-z_$][\w$]*\s*\(`,
    "g",
  );
  for (const m of code.matchAll(methodAnchor)) {
    const span = parenSpan(m.index + m[0].length - 1);
    if (!span) continue;
    const after = code.slice(span.end + 1);
    if (/^\s*(?::[^{};()]*)?\{/.test(after)) addBindingSegment(span.inner);
  }
  // catch (e)
  for (const m of code.matchAll(/\bcatch\s*\(/g)) {
    const span = parenSpan(m.index + m[0].length - 1);
    if (span) addBindingSegment(span.inner);
  }
  // class names are TDZ bindings (function declarations hoist, classes don't)
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) {
    bound.add(m[1] ?? "");
  }
  // const/let/var declarator patterns — balanced + multiline. The span runs
  // to the first top-level `;` (or an unbalanced closer: for-headers), so
  // `const {\n  inputSchema,\n} = getSchemas();` collects inputSchema.
  for (const m of code.matchAll(/\b(?:const|let|var)\b/g)) {
    const start = m.index + m[0].length;
    let depth = 0;
    let end = code.length;
    for (let i = start; i < code.length; i++) {
      const ch = code[i];
      if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth < 0) {
          end = i;
          break;
        }
      } else if (depth === 0 && ch === ";") {
        end = i;
        break;
      }
    }
    addBindingSegment(code.slice(start, end));
  }
  return bound;
}

export interface HoistOptions {
  /**
   * Imported identifiers matching this pattern are treated as schema chain
   * roots even without an inline z.* reference. A string is compiled as a
   * RegExp source; null disables name-based matching.
   * @default /ZodSchema$/
   */
  schemaNamePattern?: RegExp | string | null | undefined;
  /**
   * Fired when the file has hoist-relevant roots and the full source scan
   * actually runs — i.e., real parse-level work happened (as opposed to the
   * microsecond import-collection bail). The disk cache uses this to decide
   * that even a null transform result is worth persisting: re-deriving
   * "nothing to hoist" costs a full scan per zod-importing file per run.
   */
  onScan?: (() => void) | undefined;
}

/**
 * Free-variable analysis of a hoisted expression's source text, for the
 * build-time compile step. Returns null when the text does not parse (it
 * always should — it was extracted by this module).
 */
export function analyzeHoistedExpression(
  text: string,
): { eagerFree: Set<string>; deferredFree: Set<string> } | null {
  try {
    const parsed = parseAssignmentAt(text, 0);
    const { eagerFree, deferredFree, impure } = analyzeCaptures(parsed);
    if (impure) return null;
    return { eagerFree, deferredFree };
  } catch {
    return null;
  }
}

/** A schema construction hoisted to module scope. */
export interface HoistedSchema {
  /** Module-scope binding name (`_zh_<hash>`). */
  name: string;
  /** Source text of the hoisted construction expression. */
  text: string;
}

export interface HoistResult {
  /** The rewritten source. */
  code: string;
  /** One entry per hoisted declaration, in declaration order. */
  schemas: HoistedSchema[];
  /**
   * The splices (input coordinates) that produced `code`, for sourcemap
   * generation: expression → `_zh_*` replacements plus the declaration-block
   * insertion. `code === applyEdits(input, edits, insert)` by construction.
   */
  edits: Edit[];
  insert: Insertion;
}

/**
 * Hoist eligible Zod schema expressions to module scope.
 * Returns the rewritten source, or null when nothing was hoisted.
 */
export function hoistZodSchemas(code: string, options?: HoistOptions): string | null {
  return hoistZodSchemasMeta(code, options)?.code ?? null;
}

/**
 * hoistZodSchemas + metadata about each hoisted declaration, so the
 * transform can compile the hoisted schemas into optimized validators.
 */
export function hoistZodSchemasMeta(code: string, options?: HoistOptions): HoistResult | null {
  // Idempotency: a file carrying hoisted declarations IS this pass's output.
  // Plain hoists are naturally inert on re-runs (depth-0 masking), but a
  // compiled hoisted decl embeds its original z.* expression inside the IIFE
  // (depth > 0) — re-hoisting it would emit a duplicate _zh_ declaration.
  if (/\bconst _zh_[0-9a-f]{8} = /.test(code)) return null;

  const imports = collectImportBindings(code);
  if (imports.all.size === 0) return null;

  const rawPattern = options?.schemaNamePattern;
  const namePattern =
    rawPattern === null
      ? null
      : rawPattern === undefined
        ? SCHEMA_NAME_PATTERN
        : typeof rawPattern === "string"
          ? new RegExp(rawPattern)
          : rawPattern;

  const roots = new Set<string>(imports.zod);
  if (namePattern) {
    for (const name of imports.all) {
      if (namePattern.test(name)) roots.add(name);
    }
  }
  // Imported roots that only qualify via an inline z.* reference in the
  // chain are validated per-expression below; scan them as candidates too.
  if (imports.zod.size > 0) {
    for (const name of imports.all) roots.add(name);
  }
  if (roots.size === 0) return null;

  options?.onScan?.();
  const { candidates, stripped } = scanSource(code, roots);
  if (candidates.length === 0) return null;

  let boundNames: Set<string> | undefined;
  function isShadowed(name: string): boolean {
    boundNames ??= collectBoundNames(stripped());
    return boundNames.has(name);
  }

  interface Hoist {
    start: number;
    end: number;
    name: string;
  }
  const hoists: Hoist[] = [];
  const declByText = new Map<string, string>();
  let consumedUntil = 0;

  for (const candidate of candidates) {
    if (candidate.index < consumedUntil) continue;

    // Masking (babel-plugin-zod-hoist nesting semantics):
    // - Depth-0 chains are top-level statements/initializers — already
    //   evaluated once per module load, nothing to gain — and their interior
    //   must not hoist separately either. Exception: concise arrow bodies
    //   (`const make = () => z.object(...)`) re-run per call.
    //   Their extent comes from the cheap scanner (findChainEnd), NOT acorn:
    //   schema modules are mostly top-level declarations, and an acorn parse
    //   per declaration only to discard it dominated cold hoist cost.
    // - Zod-rooted chains mask their interior REGARDLESS of eligibility (an
    //   inner z.string() of `z.object({ a: z.string(), b: local })` belongs
    //   to the outer schema — babel's isNestedInZodCall).
    // - Chains rooted elsewhere (`sql.type(...)`, `api.get(...)`,
    //   `Base.extend(...)`) mask their interior only when actually hoisted:
    //   a rejected outer chain leaves its arguments free, so the inner
    //   `z.object({...})` of `sql.type(z.object({...}))` hoists on its own.
    if (candidate.depth === 0 && !candidate.afterArrow) {
      consumedUntil = findChainEnd(code, candidate.index);
      continue;
    }

    let parsed: Expression;
    try {
      parsed = parseAssignmentAt(code, candidate.index);
    } catch {
      continue;
    }
    let chain = narrowToCallChain(parsed, candidate.index);
    if (!chain) continue;

    const rootIsZod = imports.zod.has(candidate.name);

    if (rootIsZod) consumedUntil = chain.end;

    // Peel trailing parse calls: for `z.object({...}).safeParse(input)`,
    // hoist the construction and leave `.safeParse(input)` — with its
    // local-variable arguments — at the call site.
    let described = describeChain(chain);
    while (
      chain !== null &&
      described !== null &&
      described.methods.length > 0 &&
      PARSE_METHODS.has(described.methods[0] as string)
    ) {
      const callee: AnyNode | null = chain.type === "CallExpression" ? chain.callee : null;
      const inner: AnyNode | null =
        callee !== null && callee.type === "MemberExpression" ? callee.object : null;
      chain = inner !== null && inner.type === "CallExpression" ? (inner as Expression) : null;
      described = chain === null ? null : describeChain(chain);
    }
    if (chain === null || described === null) continue;
    // Tighten the zod-rooted mask to the peeled construction extent: the
    // arguments of a peeled `.parse(...)` are not part of the schema, so
    // candidates inside them stay free (babel traverses execution-method
    // arguments normally).
    if (rootIsZod) consumedUntil = chain.end;
    if (described.root !== candidate.name) continue;
    if (described.methods.some((m) => PARSE_METHODS.has(m))) continue;

    const rootMatchesPattern = namePattern?.test(candidate.name) === true;
    // Non-z bases must look like schema derivation: the chain must START
    // with a combinator (`Base.extend({...}).optional()` qualifies via
    // extend), so an arbitrary imported object with a z-mentioning argument
    // (`api.get(z.string())`) is never hoisted. describeChain records
    // methods outermost-first — the deepest method is last.
    const deepestMethod = described.methods[described.methods.length - 1];
    if (!rootIsZod && (deepestMethod === undefined || !COMBINATOR_METHODS.has(deepestMethod))) {
      continue;
    }

    const { eagerFree, deferredFree, impure } = analyzeCaptures(chain);
    if (impure) continue;
    // Capture rule (babel-plugin-zod-hoist's canSafelyHoist, hardened): a
    // free name is safe only when it is an import or a recognized standard
    // global, and is never re-bound anywhere in the file (no scope info, so
    // a name bound in ANY function cannot be trusted to mean the import —
    // over-rejection only costs a missed hoist). The babel plugin also
    // allows arbitrary unbound identifiers, but it has real scope analysis;
    // here an unknown bare name is more likely a binding the lexical
    // collector missed than a genuine global, and hoisting it would crash
    // at module load (`ReferenceError: <name> is not defined`).
    let eligible = true;
    for (const name of eagerFree) {
      if ((!imports.all.has(name) && !KNOWN_GLOBALS.has(name)) || isShadowed(name)) {
        eligible = false;
        break;
      }
    }
    if (eligible) {
      for (const name of deferredFree) {
        if ((!imports.all.has(name) && !KNOWN_GLOBALS.has(name)) || isShadowed(name)) {
          eligible = false;
          break;
        }
      }
    }
    if (!eligible) continue;

    // Non-zod, non-pattern roots qualify only when the chain itself
    // references a zod binding (`Base.extend({ a: z.string() })`).
    if (!rootIsZod && !rootMatchesPattern) {
      let referencesZod = false;
      for (const name of eagerFree) {
        if (imports.zod.has(name)) {
          referencesZod = true;
          break;
        }
      }
      for (const name of deferredFree) {
        if (imports.zod.has(name)) {
          referencesZod = true;
          break;
        }
      }
      if (!referencesZod) continue;
    }

    const text = code.slice(candidate.index, chain.end);
    let declName = declByText.get(text);
    if (!declName) {
      declName = `_zh_${fnv1a(text)}`;
      declByText.set(text, declName);
    }
    hoists.push({ start: candidate.index, end: chain.end, name: declName });
    // Non-zod-rooted chains mask their interior only on success — the inner
    // parts are consumed by this hoist's replacement.
    consumedUntil = Math.max(consumedUntil, chain.end);
  }

  if (hoists.length === 0) return null;

  const decls = [...declByText.entries()]
    .map(([text, name]) => `const ${name} = ${text};`)
    .join("\n");
  // The insertion offset is identical in input and output coordinates: the
  // directive prologue precedes every statement, and all hoist replacements
  // sit inside statements.
  const edits: Edit[] = hoists.map((h) => ({ start: h.start, end: h.end, text: h.name }));
  const insert: Insertion = { offset: insertionOffset(code), text: `${decls}\n` };
  return {
    code: applyEdits(code, edits, insert),
    schemas: [...declByText.entries()].map(([text, name]) => ({ name, text })),
    edits,
    insert,
  };
}
