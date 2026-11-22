import type { AnyNode, Expression, Options } from "acorn";
import { Parser } from "acorn";
import { IDENTIFIER, IDENTIFIER_PART, IDENTIFIER_START } from "../core/identifier.js";
import { applyEdits, type Edit, type Insertion, moduleHeadOffset } from "./edits.js";

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
 *
 * The same scan also finds the schemas that need no hoisting and that export
 * discovery cannot see — built at module scope, in an argument or a private
 * binding — so the transform can compile them where they stand. See
 * analyzeZodSchemas.
 */

/**
 * Imported identifiers matching this pattern are treated as schema roots.
 *
 * The default must keep implying a "Zod" substring: it is one of the three
 * triggers the transform hook's `code` filter (ZOD_MENTION in transform.ts)
 * is a superset of. A default that matched, say, `/Schema$/` would make
 * hoistable files without any "zod" mention invisible to bundlers with native
 * hook filters. (A *user-supplied* pattern is handled — it drops the filter.)
 */
export const SCHEMA_NAME_PATTERN = /ZodSchema$/;

/**
 * Module specifiers whose bindings count as the zod namespace. Every entry
 * must contain "zod" for the same reason as SCHEMA_NAME_PATTERN above; both
 * are pinned by `describe("code filter soundness")` in the transform tests.
 */
export const ZOD_MODULES = new Set([
  "zod",
  "zod/v3",
  "zod/v4",
  "zod/mini",
  "zod/v4/mini",
  "zod/v4-mini",
]);

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

/**
 * The declaration name of a hoisted construction: `_zh_` and a hash of its
 * text, hashed again with a counter while a different text holds that name.
 * Two texts can share 32 bits, and two declarations of one name are a
 * SyntaxError — for a file of 4,000 hoists, about one in 500.
 */
function hoistedName(text: string, taken: ReadonlySet<string>): string {
  let name = `_zh_${fnv1a(text)}`;
  for (let n = 1; taken.has(name); n++) name = `_zh_${fnv1a(`${n}\0${text}`)}`;
  return name;
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
  /**
   * Where the top-level statement the candidate belongs to starts. At depth 0
   * the text from here to the candidate is what the chain initializes —
   * `export const X = `, `const X = `, or nothing — which is all that
   * {@link collectModuleScope} needs to tell an export from a private binding
   * without parsing either.
   */
  statement: number;
  /**
   * An `=>` came earlier in that statement, so a depth-0 candidate may be
   * further into a concise arrow body than {@link afterArrow} can see
   * (`() => cond && z.object(…)`).
   */
  arrowBody: boolean;
}

/** Keywords that only ever begin a statement. */
const STATEMENT_KEYWORDS = new Set([
  "export",
  "const",
  "let",
  "var",
  "function",
  "class",
  "if",
  "for",
  "while",
  "switch",
  "try",
  "do",
]);

/** Tokens a statement keyword follows without beginning a new statement. */
const STATEMENT_MODIFIERS = new Set(["export", "default", "async", "declare", "abstract"]);

/** Is there a line break in the whitespace directly before `index`? */
function followsLineBreak(code: string, index: number): boolean {
  for (let i = index - 1; i >= 0 && isSpaceCode(code.charCodeAt(i)); i--) {
    if (code.charCodeAt(i) === 10) return true;
  }
  return false;
}

/**
 * Does the word at `index`, read at depth 0 after `lastToken`, begin a new
 * top-level statement? A statement keyword does; so does anything on a new
 * line after a token that can end an expression — the automatic-semicolon
 * rule, near enough, for sources that leave semicolons out.
 */
function beginsStatement(code: string, index: number, word: string, lastToken: string): boolean {
  if (STATEMENT_KEYWORDS.has(word)) {
    return lastToken !== "." && !STATEMENT_MODIFIERS.has(lastToken);
  }
  return isDivisionContext(lastToken) && followsLineBreak(code, index);
}

/**
 * Char-code identifier/whitespace classes for the scanner hot loops — a
 * regex `.test()` per character dominated scan time once the acorn parses
 * were gone. ASCII is decided by range; a code point past it, rare in code
 * outside strings and comments, by the classes identifiers are defined by.
 * Read as ASCII alone, `éz.object(…)` was an `é` and then a `z`, and the `z`
 * zod is imported as had the call hoisted off a binding of the user's, leaving
 * `é_zh_…` where it stood. Either half of a surrogate pair counts: outside a
 * string or a comment, a character past the BMP can only be part of a name.
 * The space check falls back to `/\s/` for the rare non-ASCII code points it
 * matches (NBSP, BOM, U+2028...).
 */
const IDENT_START_CHARACTER = new RegExp(`^${IDENTIFIER_START}$`, "u");
const IDENT_PART_CHARACTER = new RegExp(`^${IDENTIFIER_PART}$`, "u");
function isSurrogateCode(c: number): boolean {
  return c >= 0xd800 && c <= 0xdfff;
}
function isIdentStartCode(c: number): boolean {
  if (c < 128) return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36;
  return c >= 128 && (isSurrogateCode(c) || IDENT_START_CHARACTER.test(String.fromCharCode(c)));
}
function isIdentPartCode(c: number): boolean {
  if (c < 128) {
    return (
      (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36
    );
  }
  return c >= 128 && (isSurrogateCode(c) || IDENT_PART_CHARACTER.test(String.fromCharCode(c)));
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

/** A name, a keyword or a number: a token the scanners read with the classes above. */
const WORD_TOKEN = new RegExp(`^${IDENTIFIER_PART}+$`, "u");

/** Is `/` after this token division (true) or a regex literal (false)? */
function isDivisionContext(lastToken: string): boolean {
  if (lastToken === ")" || lastToken === "]") return true;
  if (/^["'`]$/.test(lastToken)) return true;
  if (WORD_TOKEN.test(lastToken)) return !REGEX_PRECEDING_KEYWORDS.has(lastToken);
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
  // The top-level statement being scanned: where it began, and whether an
  // `=>` has appeared in it at depth 0.
  let statementStart = 0;
  let statementArrow = false;
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
      lastToken = templateChunkToken(code, end);
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
      lastToken = templateChunkToken(code, end);
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
      if (depth === 0 && beginsStatement(code, i, word, lastToken)) {
        statementStart = i;
        statementArrow = false;
      }
      if (roots.has(word) && code[k] === "." && lastToken !== ".") {
        candidates.push({
          index: i,
          depth,
          name: word,
          afterArrow: lastToken === "=>",
          statement: statementStart,
          arrowBody: statementArrow,
        });
      }
      lastToken = word;
      i = j;
      continue;
    }

    if (!isSpaceCode(code.charCodeAt(i))) {
      lastToken = ch === ">" && lastToken === "=" ? "=>" : ch;
      if (depth === 0) {
        if (ch === ";") {
          statementStart = i + 1;
          statementArrow = false;
        } else if (lastToken === "=>") {
          statementArrow = true;
        }
      }
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

/**
 * `code` with its comments, the text of its strings and templates, and its
 * regex literals blanked to spaces, every offset kept: what is left runs.
 */
export function codeOnly(code: string): string {
  return scanSource(code, new Set()).stripped();
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

/**
 * The token a template chunk that ended at `end` leaves the scanner on.
 *
 * A chunk ends at the closing backtick or at a `${`, and what a `/` means
 * next depends on which. After the literal it divides. After `${` an
 * expression begins, so it opens a regex — and reading that one as a division
 * loses the scanner its place for the rest of the file: `${/[/]/.test(v)}`
 * came out as a division, an array holding a regex, and one closing brace too
 * few, after which the literal's own closing backtick OPENED a template. From
 * there code was read as text and text as code, and a later literal whose
 * text happened to read like a schema (`` `z.string() is how …` ``) had that
 * text hoisted out of it.
 */
function templateChunkToken(code: string, end: number): string {
  return code[end - 1] === "{" && code[end - 2] === "$" ? "${" : "`";
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
        lastToken = templateChunkToken(code, i);
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
        lastToken = templateChunkToken(code, i);
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
 *
 * The parse runs over a slice starting at `pos`, and its nodes are moved back
 * to `code`'s offsets afterwards. Handed a start position instead, acorn's
 * constructor counts the lines before it by splitting everything up to there,
 * and a raised error counts them again. One parse per schema of a large file
 * made the scan quadratic in the file's length.
 */
function parseAssignmentAt(code: string, pos: number): Expression {
  interface ParserInternals {
    nextToken(): void;
    parseMaybeAssign(): Expression;
  }
  const parser = new (Parser as unknown as new (
    options: Options,
    input: string,
  ) => ParserInternals)(
    { ecmaVersion: "latest", sourceType: "module" },
    pos === 0 ? code : code.slice(pos),
  );
  parser.nextToken();
  const parsed = parser.parseMaybeAssign();
  if (pos !== 0) shiftNodes(parsed, pos);
  return parsed;
}

/** Move every node of an acorn tree `delta` characters on. */
function shiftNodes(root: AnyNode, delta: number): void {
  const seen = new Set<object>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      pending.push(...(value as unknown[]));
      continue;
    }
    // A node is what has a `type` and a position. A regex literal's `value`
    // and `regex`, or a template element's `value`, are plain data.
    const node = value as { type?: unknown; start?: unknown; end?: unknown };
    if (typeof node.type !== "string" || typeof node.start !== "number") continue;
    (node as AnyNode).start += delta;
    (node as AnyNode).end += delta;
    pending.push(...Object.values(node));
  }
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

/** Heads of statements whose parentheses hold a condition, not arguments. */
const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with"]);

/** Words after which a `{` opens an object literal rather than a block. */
const LITERAL_BRACE_KEYWORDS = new Set([
  "return",
  "typeof",
  "void",
  "yield",
  "await",
  "in",
  "of",
  "new",
  "default",
  "case",
  "throw",
]);

/** Does a `{` after `lastToken` open an object literal, as opposed to a body or a block? */
function opensObjectLiteral(lastToken: string): boolean {
  if (lastToken === "" || lastToken === "=>") return false;
  if (WORD_TOKEN.test(lastToken)) return LITERAL_BRACE_KEYWORDS.has(lastToken);
  // After an operator or an opening bracket a value is due. After `)` it is
  // a function body or a controlled block; after `}` or `;`, a block.
  return !/^[)\]};"'`]$/.test(lastToken);
}

/**
 * A token a return type can end on, so that a `{` after it is the body: a
 * name, the close of a generic, an array, an object type or a parenthesized
 * one, a literal. (After `:`, `|`, `<` and the like the type is still going.)
 */
const ENDS_TYPE = new RegExp(`^(?:${IDENTIFIER_PART}+|[>\\]})"'\`])$`, "u");

/** What the scanner knows about one open bracket. */
interface Frame {
  /** Offset of the opening bracket. */
  open: number;
  /**
   * Its contents run exactly when the code around it does: call arguments, a
   * grouping, an array or object literal. False for a function or class body,
   * a controlled block, a parameter list.
   */
  inline: boolean;
  /** An `=>` at this level: what follows, to the next comma, is an arrow body. */
  arrow: boolean;
  /** The `(` of a call that builds a schema, whose arguments are that schema's parts. */
  building: boolean;
  /**
   * …except that it is one of zod's own parse functions (`z.safeParse(Body,
   * value)`, the form `zod/mini` is written in): what it is given is a schema
   * to validate with, not a part of one.
   */
  validating: boolean;
  /** The member chain in progress where this bracket opened, resumed when it closes. */
  root: string | null;
  first: string | null;
}

/** One mention, in code, of a name the scan was asked to watch. */
interface Reference {
  name: string;
  /**
   * What the mention does with the schema the name is bound to:
   *
   * - `validated`: validates with it (`Body.safeParse(…)`) — the one thing a
   *   compiled validator makes faster, and the one thing a bag of methods does
   *   as well as the schema;
   * - `passed`: hands the schema itself on — an argument, a return value, an
   *   export, an alias. Whoever receives it may validate with it;
   * - `schema`: needs it AS a schema and gains nothing from a validator —
   *   another schema is built from it (`Base.extend(…)`, a member of a
   *   `z.object`), or something else is read off it (`.shape`, `.decode(…)`);
   * - `none`: not a use — its declaration, a type query, a key of that name.
   */
  kind: "none" | "passed" | "schema" | "validated";
  /**
   * For `passed`: the module-scope declaration whose initializer the mention
   * sits in (`validateUser` for `const validateUser = compile(User)`), which
   * may therefore BE this schema under another name.
   */
  within?: string;
}

interface InteriorScan {
  /**
   * Zod-rooted chains that sit where module-scope code runs exactly once and
   * are not part of a larger schema, in source order (offsets of the root).
   */
  schemas: number[];
  references: Reference[];
}

/**
 * Scan `code[from, to)` for zod-rooted chains, this time knowing what each
 * bracket IS.
 *
 * {@link scanSource} counts depth, which is all hoisting needs: anything below
 * depth 0 is taken to be inside a function. That is the wrong question here.
 * `t.procedure.input(z.object({…}))` at module scope puts its schema at depth 1
 * and still evaluates it once, while the body of the callback two arguments
 * later runs per request. So each bracket is classified as it opens — call
 * arguments and literals pass the evaluation of their surroundings through,
 * function bodies and parameter lists do not — and an `=>` turns the rest of
 * its level into a body.
 *
 * The classification is lexical, so it can be wrong, and it is built to be
 * wrong in one direction: a doubt makes a position "not module scope", which
 * leaves the schema as it was written. The other direction would still be
 * correct — compiling in place never moves an expression — just pointless,
 * rebuilding a validator on every call.
 *
 * `builds(root, first)` says whether a call on the chain `root.first…(` builds
 * a schema; `watch` names bindings whose uses are reported.
 */
function scanInterior(
  code: string,
  from: number,
  to: number,
  zod: ReadonlySet<string>,
  builds: (root: string, first: string | null) => boolean,
  watch?: ReadonlySet<string>,
): InteriorScan {
  const found: number[] = [];
  const references: Reference[] = [];
  const frames: Frame[] = [];
  const templateStack: number[] = [];
  // [open, close) of bracket pairs that turned out to be parameter lists or
  // statement heads — known only once what follows the `)` has been seen.
  const heads: number[] = [];
  let lastToken = "";
  // The member chain in progress at the current level.
  let root: string | null = null;
  let first: string | null = null;
  // An `=>` at the outermost level of the range.
  let outerArrow = false;
  // The `(` of a pair that has just closed and may yet turn out to have held
  // parameters. Only what follows says: an `=>`, a body, or a return type and
  // then one of those. `typed` is that return type under way — a `:` followed
  // the `)` — and `angle` how deep in its `<…>` the scan is.
  let pending = -1;
  let pendingDepth = -1;
  let typed = false;
  let angle = 0;
  let functionHead = false;
  let statementStart = from;
  let i = from;

  const forget = (): void => {
    pending = -1;
    typed = false;
    angle = 0;
  };
  /** The pending parentheses were a parameter list (or a statement's head), which ends at `at`. */
  const settle = (at: number): void => {
    heads.push(pending, at);
    forget();
  };

  while (i < to) {
    const ch = code[i] as string;
    const next = code[i + 1];

    if (ch === "/" && next === "/") {
      const nl = code.indexOf("\n", i);
      i = nl === -1 ? to : nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = code.indexOf("*/", i + 2);
      i = close === -1 ? to : close + 2;
      continue;
    }
    if (ch === "/") {
      if (!isDivisionContext(lastToken)) {
        i = skipRegexLiteral(code, i);
        lastToken = ")"; // a regex literal is an operand
      } else {
        lastToken = ch;
        i++;
      }
      root = null;
      forget();
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(code, i, ch);
      lastToken = ch;
      root = null;
      // (A string can be a type: `(kind): "a" | "b" => …`.)
      if (!typed) forget();
      continue;
    }
    if (ch === "`") {
      i = skipTemplateChunk(code, i + 1, templateStack, frames.length);
      lastToken = templateChunkToken(code, i);
      root = null;
      forget();
      continue;
    }
    if (
      templateStack.length > 0 &&
      ch === "}" &&
      frames.length === templateStack[templateStack.length - 1]
    ) {
      templateStack.pop();
      i = skipTemplateChunk(code, i + 1, templateStack, frames.length);
      lastToken = templateChunkToken(code, i);
      root = null;
      forget();
      continue;
    }

    if (ch === "(" || ch === "[" || ch === "{") {
      let inline = true;
      let building = false;
      // After a parameter list, or after the return type that follows one, a
      // brace opens a body. (Directly after the `:` it is still the type.)
      const body =
        ch === "{" &&
        pending !== -1 &&
        frames.length === pendingDepth &&
        (lastToken === ")" || (typed && ENDS_TYPE.test(lastToken)));
      if (body) settle(i);
      else if (!typed) forget();
      let validating = false;
      if (ch === "(") {
        inline = !functionHead && !CONTROL_KEYWORDS.has(lastToken);
        functionHead = false;
        building = root !== null && builds(root, first);
        validating = building && zod.has(root as string) && PARSE_METHODS.has(first ?? "");
      } else if (ch === "{") {
        inline = !body && opensObjectLiteral(lastToken);
      }
      frames.push({ open: i, inline, arrow: false, building, validating, root, first });
      root = null;
      first = null;
      lastToken = ch;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      const frame = frames.pop();
      // A chain goes on after a call or an index (`a.b(c).d`), not after a block.
      root = frame !== undefined && ch !== "}" ? frame.root : null;
      first = frame !== undefined && ch !== "}" ? frame.first : null;
      // A pair that closes inside a return type is part of the type; one that
      // closes around the pending pair ends it.
      const inType = typed && pending !== -1 && frames.length >= pendingDepth;
      if (!inType) {
        forget();
        if (ch === ")" && frame !== undefined) {
          pending = frame.open;
          pendingDepth = frames.length;
        }
      }
      lastToken = ch;
      i++;
      continue;
    }

    if (isIdentStartCode(code.charCodeAt(i)) && !isIdentPartCode(code.charCodeAt(i - 1))) {
      let j = i + 1;
      while (j < to && isIdentPartCode(code.charCodeAt(j))) j++;
      const word = code.slice(i, j);
      let k = j;
      while (k < to && isSpaceCode(code.charCodeAt(k))) k++;

      if (frames.length === 0 && beginsStatement(code, i, word, lastToken)) {
        statementStart = i;
        outerArrow = false;
        forget();
      }
      // Between a parameter list and its arrow or body there are words only
      // in a return type (`(a): Promise<T> => …`).
      if (!typed) forget();
      if (lastToken === ".") {
        if (root !== null && first === null) first = word;
        // A property that happens to share the name: seen, and not a use.
        if (watch?.has(word)) references.push({ name: word, kind: "none" });
      } else {
        if (word === "function") functionHead = true;
        // (`new z.ZodString(…)` is not a chain: an arrow cannot be constructed.)
        if (zod.has(word) && code[k] === "." && lastToken !== "new") {
          // In place means evaluated once, so: every enclosing bracket passes
          // evaluation through, none of them is the argument list of a call
          // that is itself building a schema, and no arrow stands in between.
          let once = !outerArrow;
          for (const frame of frames) {
            if (!frame.inline || frame.arrow || frame.building) once = false;
          }
          if (once) found.push(i);
        }
        if (watch?.has(word)) {
          references.push(classifyReference(code, word, i, k, lastToken, frames, statementStart));
        }
        root = word;
        first = null;
      }
      lastToken = word;
      i = j;
      continue;
    }

    if (isSpaceCode(code.charCodeAt(i))) {
      i++;
      continue;
    }

    if (ch === "=" && next === ">") {
      // What the parentheses before an arrow held were its parameters.
      if (pending !== -1 && frames.length === pendingDepth && (typed || lastToken === ")")) {
        settle(i);
      } else if (!typed) {
        forget();
      }
      const frame = frames[frames.length - 1];
      if (frame === undefined) outerArrow = true;
      else frame.arrow = true;
      root = null;
      lastToken = "=>";
      i += 2;
      continue;
    }
    if (ch === "." && next === "." && code[i + 2] === ".") {
      // A spread: what follows is an expression of its own, not a member.
      if (!typed) forget();
      root = null;
      lastToken = "...";
      i += 3;
      continue;
    }
    if (ch === "." || (ch === "?" && next === "." && !/[0-9]/.test(code[i + 2] ?? ""))) {
      if (!typed) forget();
      lastToken = ".";
      i += ch === "." ? 1 : 2;
      continue;
    }
    if (ch === ",") {
      const frame = frames[frames.length - 1];
      if (frame === undefined) outerArrow = false;
      else frame.arrow = false;
    } else if (ch === ";" && frames.length === 0) {
      statementStart = i + 1;
      outerArrow = false;
    }
    if (typed) {
      // Still a return type? Its own punctuation says yes; an operator, the
      // end of a statement, or a comma outside its `<…>` says this was a
      // conditional's `:` all along.
      if (ch === "<") angle++;
      else if (ch === ">") angle = Math.max(0, angle - 1);
      else if (ch === ";" || (ch === "," && angle === 0) || /[=+\-*%!^~]/.test(ch)) forget();
    } else if (
      ch === ":" &&
      pending !== -1 &&
      lastToken === ")" &&
      frames.length === pendingDepth
    ) {
      typed = true;
    } else {
      forget();
    }
    root = null;
    lastToken = ch;
    i++;
  }

  // A schema inside what turned out to be a parameter list or a statement
  // head is a default value or a condition, not a module-scope expression.
  const schemas = found.filter((index) => {
    for (let h = 0; h < heads.length; h += 2) {
      if (index > (heads[h] as number) && index < (heads[h + 1] as number)) return false;
    }
    return true;
  });
  return { schemas, references };
}

/**
 * The members a compiled validator answers itself — everything `__zcMkv`
 * installs that is called by name. A bag (`output: "bag"`) has these and no
 * others.
 */
const VALIDATOR_METHODS = new Set(["parse", "safeParse", "parseAsync", "safeParseAsync", "is"]);

/** A statement that declares a binding and has reached its initializer. */
const DECLARATION = new RegExp(
  String.raw`^(?:export\s+)?(?:const|let|var)\s+(${IDENTIFIER})\s*(?::[^=]*)?=`,
  "u",
);

/** The member a `.` or `?.` reads, from the start of the text. */
const MEMBER = new RegExp(String.raw`^\??\.\s*(${IDENTIFIER})`, "u");

/** The first member read off the name the text starts with: `extend`, for `Base.extend(…)`. */
const ROOT_MEMBER = new RegExp(String.raw`^${IDENTIFIER_PART}+\s*\??\.\s*(${IDENTIFIER})`, "u");

/** Words after which a name is being declared or queried for its type, not used. */
const NON_USE_PRECEDING = new Set([
  "const",
  "let",
  "var",
  "function",
  "class",
  "typeof",
  "type",
  "interface",
  "enum",
  "namespace",
]);

/**
 * What a mention of a watched binding is to that binding. `at` is where the
 * identifier starts and `after` the offset of the token that follows it.
 */
function classifyReference(
  code: string,
  name: string,
  at: number,
  after: number,
  lastToken: string,
  frames: readonly Frame[],
  statementStart: number,
): Reference {
  // Its own declaration, a type query (`z.infer<typeof X>`), a type of the
  // same name: none of them uses the schema.
  if (NON_USE_PRECEDING.has(lastToken)) return { name, kind: "none" };
  // An object literal's key.
  if (code[after] === ":" && (lastToken === "{" || lastToken === ","))
    return { name, kind: "none" };

  if (code[after] === "." || (code[after] === "?" && code[after + 1] === ".")) {
    const member = MEMBER.exec(code.slice(after, after + 80));
    // `X.parse(…)` is the same call wherever it is written; any other member
    // is read off the schema, and most of them derive a new one from it.
    return {
      name,
      kind: member !== null && VALIDATOR_METHODS.has(member[1] as string) ? "validated" : "schema",
    };
  }
  // Handed to a call that is building a schema: a part of that schema. The
  // nearest such call decides — `z.safeParse(Body, value)` validates with it.
  for (let f = frames.length - 1; f >= 0; f--) {
    const frame = frames[f] as Frame;
    if (!frame.building) continue;
    if (frame.validating) break;
    return { name, kind: "schema" };
  }
  const declared = DECLARATION.exec(code.slice(statementStart, at));
  if (declared !== null && declared[1] !== name) {
    return { name, kind: "passed", within: declared[1] as string };
  }
  return { name, kind: "passed" };
}

/** A schema construction at module scope that can be compiled where it stands. */
export interface ModuleScopeSchema {
  /** Extent of the construction in the analysed source. */
  start: number;
  end: number;
  /** Its source text. */
  text: string;
  /** An identifier to name the validator's functions after: the binding, or a hash of the text. */
  label: string;
  /** For the initializer of `const <name> = …`: the binding. Absent for an argument. */
  name?: string;
  /**
   * For a binding: the module-scope declarations that take the schema itself
   * into their initializer (`export const Alias = name`, `const v =
   * compile(name)`). Any of them may be the same object under another name —
   * and if discovery compiles that one, this one is compiled already.
   */
  within?: string[];
  /**
   * For a binding: nothing in the file does anything with it but validate.
   * Every mention of the name — counted in the raw text, so including the ones
   * a lexical scan cannot read, in a comment or a string or JSX — is its
   * declaration, a type query or a call of one of {@link VALIDATOR_METHODS}.
   * Only then can a bag of methods stand where the schema stood.
   */
  contained?: boolean;
}

/**
 * What may follow a construction that is the whole of an initializer: the end
 * of the declarator or the line, a comment, or a TypeScript assertion.
 */
const ENDS_INITIALIZER = /^\s*(?:[;,\n]|$|\/\/|(?:as|satisfies)\b)/;

/** `const Name = ` and nothing else, up to the end of the text. Not exported. */
const PRIVATE_CONST = /^const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*$/;

/** Every `const Name = Root.` in the text, wherever it is. */
const CONST_CHAIN = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*([A-Za-z_$][\w$]*)\s*\./g;

/** How many times each of `names` is written in `code` as a whole word, wherever that is. */
function countMentions(code: string, names: ReadonlySet<string>): Map<string, number> {
  // Each of `names` is `[A-Za-z_$][\w$]*`, so a mention — the name with no
  // `[\w$]` on either side — is a maximal run of those characters equal to
  // it. One pass counts them all; a pattern per name, each run over the whole
  // file, was quadratic in the private schemas a file declares.
  const counts = new Map<string, number>();
  for (const [word] of code.matchAll(/[\w$]+/g)) {
    if (names.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/**
 * Names bound by `const` to a chain that starts at a zod binding, or at
 * another such name. A superset — the pattern is matched against the raw text,
 * strings and nested scopes included — which is the safe direction for what it
 * decides: a name wrongly counted makes a call on it a schema-building one,
 * whose arguments are then left alone.
 */
function schemaConstants(code: string, zod: ReadonlySet<string>): Set<string> {
  const pairs: [name: string, root: string][] = [];
  for (const match of code.matchAll(CONST_CHAIN)) {
    pairs.push([match[1] as string, match[2] as string]);
  }
  const names = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, root] of pairs) {
      if (!names.has(name) && (zod.has(root) || names.has(root))) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
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

/** What {@link analyzeZodSchemas} is asked to find. */
export interface AnalyzeOptions extends HoistOptions {
  /**
   * Collect schemas built inside functions, to be moved to module scope.
   * @default true
   */
  hoist?: boolean | undefined;
  /**
   * Also report the schemas built AT module scope that no export scan will
   * ever see (see {@link ModuleScopeSchema}), to be compiled where they stand.
   * @default false
   */
  moduleScope?: boolean | undefined;
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

/** One scan's findings: what to move, and what to compile without moving. */
export interface SchemaAnalysis {
  /** The hoist, or null when nothing was (or was to be) hoisted. */
  hoist: HoistResult | null;
  /** Module-scope schemas that can be compiled in place, in source order. */
  moduleScope: ModuleScopeSchema[];
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
  return analyzeZodSchemas(code, options).hoist;
}

/**
 * The one scan behind both things done to schemas that are not exports:
 * hoisting the ones built inside functions, and — with `moduleScope` — finding
 * the ones built at module scope where nothing will find them.
 *
 * Those are the schemas export discovery cannot reach, and until this they ran
 * as plain Zod however many requests went through them: the argument of
 * `t.procedure.input(…)` or `zValidator("json", …)`, and the private
 * `const Body = z.object(…)` a handler parses with. They are not hoisted,
 * because there is nowhere better to put them — they are evaluated once
 * already. They are reported so the transform can compile each IN PLACE, the
 * expression replaced by a validator wrapped around that same expression:
 * nothing moves, so evaluation order, scoping and the identity of the schema
 * object are what they were.
 *
 * Two kinds are reported and no others:
 *
 * - a zod-rooted expression among the ARGUMENTS of a module-scope chain that
 *   is not itself a schema (`t.router({ a: t.procedure.input(HERE) })`). Only
 *   the outermost one: what is inside it is part of it.
 * - the initializer of a private `const` that something USES — parses with,
 *   passes on, exports under another name. One that only other schemas are
 *   built from (`Base.extend(…)`, a member of a `z.object`) is left plain: the
 *   schema built from it validates the whole thing, and a validator of its own
 *   would be bytes and module-init work for nothing.
 *
 * Deciding which is which costs no parse. A depth-0 chain is already measured
 * by {@link findChainEnd} to mask it, and the text between the start of its
 * statement and its root says whether it initializes an export, a private
 * binding or nothing; acorn only sees the handful that survive, as it does for
 * hoists. (Parsing every top-level declaration is what this file once did, and
 * it was most of a cold build's hoist time.)
 */
export function analyzeZodSchemas(code: string, options?: AnalyzeOptions): SchemaAnalysis {
  const nothing: SchemaAnalysis = { hoist: null, moduleScope: [] };
  // Idempotency: a file carrying hoisted declarations IS this pass's output.
  // Plain hoists are naturally inert on re-runs (depth-0 masking), but a
  // compiled hoisted decl embeds its original z.* expression inside the IIFE
  // (depth > 0) — re-hoisting it would emit a duplicate _zh_ declaration.
  if (/\bconst _zh_[0-9a-f]{8} = /.test(code)) return nothing;

  const imports = collectImportBindings(code);
  if (imports.all.size === 0) return nothing;
  const wantHoist = options?.hoist !== false;
  const wantModuleScope = options?.moduleScope === true;

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
  if (roots.size === 0) return nothing;

  options?.onScan?.();
  const { candidates, stripped } = scanSource(code, roots);
  if (candidates.length === 0) return nothing;

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
  const declNames = new Set<string>();
  let consumedUntil = 0;

  const moduleScope: ModuleScopeSchema[] = [];
  /** Private `const` schemas at module scope, to be kept or dropped by how they are used. */
  const bindings: { name: string; index: number }[] = [];
  let constants: Set<string> | undefined;

  /**
   * Does a call on the chain `root.first…(` build a schema? Then what it is
   * given are parts of that schema, not schemas to compile on their own.
   */
  const builds = (root: string, first: string | null): boolean => {
    if (imports.zod.has(root)) return true;
    constants ??= schemaConstants(code, imports.zod);
    // A schema held in a module binding: `Base.extend(…)` builds, `Base.parse(…)` uses.
    if (constants.has(root)) return first !== null && !PARSE_METHODS.has(first) && first !== "is";
    if (!imports.all.has(root)) return false;
    // The rule hoisting applies to imported bases: named like a schema, or
    // derived from with a combinator.
    return namePattern?.test(root) === true || (first !== null && COMBINATOR_METHODS.has(first));
  };

  /**
   * The schema construction rooted at `index`, or null when what is there is
   * not one that can be compiled where it stands.
   */
  const constructionAt = (index: number): ModuleScopeSchema | null => {
    let parsed: Expression;
    try {
      parsed = parseAssignmentAt(code, index);
    } catch {
      // TypeScript inside the expression (a generic call, a cast): left as written.
      return null;
    }
    const chain = narrowToCallChain(parsed, index);
    if (chain === null) return null;
    // The chain has to be the whole value. acorn stops where the JavaScript it
    // can read stops, so `z.string().transform<number>(…)` narrows to its
    // `z.string()`, and `z.object(…).shape` to its `z.object(…)`: a validator
    // there would be for a schema nothing validates with.
    if (/^\s*(?:\?\.|[.(<[`])/.test(code.slice(chain.end, chain.end + 40))) return null;
    const described = describeChain(chain);
    // `z.object(…).parse(x)` builds a schema, uses it once and drops it.
    if (described === null || described.methods.some((m) => PARSE_METHODS.has(m))) return null;
    // `this`, `super`, an eager `await`: not something to evaluate at build time.
    if (analyzeCaptures(chain).impure) return null;
    const text = code.slice(index, chain.end);
    return { start: index, end: chain.end, text, label: `_zi_${fnv1a(text)}` };
  };

  /** Look at a statement-level chain for the schemas discovery will not find in it. */
  const collectModuleScope = (candidate: Candidate, end: number): void => {
    if (imports.zod.has(candidate.name)) {
      // A schema at statement level. An exported one is discovery's; a private
      // binding it never sees. Nothing else here is a schema to keep.
      const declared = PRIVATE_CONST.exec(code.slice(candidate.statement, candidate.index));
      if (declared !== null) bindings.push({ name: declared[1] as string, index: candidate.index });
      return;
    }
    const member = ROOT_MEMBER.exec(code.slice(candidate.index, candidate.index + 120));
    // A schema derived from an imported one (`Base.extend(…)`): what it is
    // given are its parts, and if it is exported, discovery has all of it.
    if (builds(candidate.name, member === null ? null : (member[1] as string))) return;
    // Anything else — a router, a route table, a tagged query — is not a
    // schema, and the schemas among its arguments are whole ones.
    // The scan reports outermost schemas only, so no two of these overlap.
    // `masked` holds that to be true whatever the scan does: overlapping edits
    // are not something to find out about from the bundler.
    let masked = candidate.index;
    for (const index of scanInterior(code, candidate.index, end, imports.zod, builds).schemas) {
      if (index < masked) continue;
      const schema = constructionAt(index);
      if (schema === null) continue;
      moduleScope.push(schema);
      masked = schema.end;
    }
  };

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
      // Once per module load is what makes compiling in place worth it; a
      // chain further into a concise arrow body is evaluated per call.
      if (wantModuleScope && !candidate.arrowBody) collectModuleScope(candidate, consumedUntil);
      continue;
    }
    if (!wantHoist) continue;

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
      declName = hoistedName(text, declNames);
      declByText.set(text, declName);
      declNames.add(declName);
    }
    hoists.push({ start: candidate.index, end: chain.end, name: declName });
    // Non-zod-rooted chains mask their interior only on success — the inner
    // parts are consumed by this hoist's replacement.
    consumedUntil = Math.max(consumedUntil, chain.end);
  }

  if (bindings.length > 0) {
    // A private binding earns a validator by being used, and whether it is
    // takes every mention of it in the file — the handler that parses with it
    // may come before the declaration or a thousand lines after.
    const watch = new Set(bindings.map((binding) => binding.name));
    const { references } = scanInterior(code, 0, code.length, imports.zod, builds, watch);
    // Grouped once: filtering every reference for each binding was quadratic
    // in the private schemas a file declares.
    const referencesOf = new Map<string, Reference[]>();
    for (const reference of references) {
      const group = referencesOf.get(reference.name);
      if (group === undefined) referencesOf.set(reference.name, [reference]);
      else group.push(reference);
    }
    let written: Map<string, number> | undefined;
    for (const { name, index } of bindings) {
      const mentions = referencesOf.get(name) ?? [];
      // Built upon and never validated with or handed on: the schemas built
      // from it are the ones that validate, and they contain it.
      if (!mentions.some((m) => m.kind === "validated" || m.kind === "passed")) continue;
      const schema = constructionAt(index);
      // An initializer has to BE the construction: `z.string() ?? fallback`
      // binds something that may not be the schema.
      if (schema === null || !ENDS_INITIALIZER.test(code.slice(schema.end, schema.end + 40))) {
        continue;
      }
      moduleScope.push({
        ...schema,
        label: name,
        name,
        within: [...new Set(mentions.flatMap((m) => (m.within === undefined ? [] : [m.within])))],
        contained:
          mentions.every((m) => m.kind === "none" || m.kind === "validated") &&
          mentions.length === ((written ??= countMentions(code, watch)).get(name) ?? 0),
      });
    }
    moduleScope.sort((a, b) => a.start - b.start);
  }

  if (hoists.length === 0) return { hoist: null, moduleScope };

  const decls = [...declByText.entries()]
    .map(([text, name]) => `const ${name} = ${text};`)
    .join("\n");
  // The insertion offset is identical in input and output coordinates: the
  // directive prologue precedes every statement, and all hoist replacements
  // sit inside statements.
  const edits: Edit[] = hoists.map((h) => ({ start: h.start, end: h.end, text: h.name }));
  const insert: Insertion = { offset: moduleHeadOffset(code), text: `${decls}\n` };
  return {
    hoist: {
      code: applyEdits(code, edits, insert),
      schemas: [...declByText.entries()].map(([text, name]) => ({ name, text })),
      edits,
      insert,
    },
    moduleScope,
  };
}
