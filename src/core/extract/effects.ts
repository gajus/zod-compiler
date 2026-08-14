/**
 * Effect compilation utilities.
 * Uses fn.toString() to extract function source text from live Zod schema references,
 * then classifies whether the function can be safely inlined (zero external captures).
 */

import type { Node } from "acorn";
import { parseExpressionAt } from "acorn";

// Well-known globals that are safe to reference in inlined functions
const SAFE_GLOBALS = new Set([
  "undefined",
  "null",
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
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURI",
  "decodeURI",
  "encodeURIComponent",
  "decodeURIComponent",
  "BigInt",
  "Symbol",
  "Map",
  "Set",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "Promise",
  "globalThis",
  "true",
  "false",
]);

/**
 * Can this refine predicate be CALLED by reference from generated code?
 *
 * Weaker than {@link tryCompileEffect}: the callback keeps its own closure, so
 * captures are fine — only shapes whose semantics the generated call could not
 * reproduce are rejected. A second parameter means the zod `ctx` protocol
 * (superRefine-style issue collection), and an async/generator function returns
 * a promise where zod's synchronous parse raises $ZodAsyncError.
 */
export function isReferenceablePredicate(fn: unknown): boolean {
  if (typeof fn !== "function") return false;
  if (fn.length >= 2) return false;
  const kind = fn.constructor?.name;
  return (
    kind !== "AsyncFunction" && kind !== "GeneratorFunction" && kind !== "AsyncGeneratorFunction"
  );
}

/** A parsed callback: the node types whose SOURCE TEXT is a usable expression. */
type FunctionNode = Node & { params?: Node[]; body?: Node };

/**
 * Not every callable stringifies to an expression, and acorn parses what it can
 * rather than refusing. A method shorthand lifted off an object literal —
 * `normalize(v) { … }` — parses as the CALL `normalize(v)` and stops at the
 * brace; a getter's source yields a bare Identifier; a class yields a
 * ClassExpression. None of those carry `params`, so every arity guard below
 * passes vacuously and `tryCompileEffect` hands back the whole source including
 * the trailing block, which lands in generated code as
 * `var __ef_2=(normalize(v) { … });` — a SyntaxError that makes the emitted
 * module unparseable while the CLI still reports success.
 *
 * Only an arrow or a function expression is safe to treat as an inlineable
 * callback. Rejecting is the conservative answer rather than merely the safe
 * one: with no parsed params there is nothing to prove the callback ignores
 * zod's second (parse-context) argument, so a refine/transform degrades to a
 * call through `__rf[N]` and a preprocess degrades further, to full zod
 * delegation. Every shape above keeps zod's own behaviour either way — a class
 * still throws on a call-without-new exactly as it does under zod.
 *
 * The parse must also have consumed the whole source. Nothing here can prove
 * `toString()` returned real source text, and a partial parse would re-open
 * this same bug class by re-emitting the unconsumed tail.
 */
function asFunctionNode(ast: Node, source: string): FunctionNode | null {
  const isFunction = ast.type === "ArrowFunctionExpression" || ast.type === "FunctionExpression";
  if (!isFunction) return null;
  return source.slice(ast.end).trim() === "" ? (ast as FunctionNode) : null;
}

/**
 * Recover a callback's parameter list from its source, or null when the source
 * does not reveal one. An arrow or function expression parses directly; a method
 * shorthand lifted off an object literal (`normalize(v) { … }`) is not an
 * expression on its own but becomes one wrapped back in the braces it came from.
 * A native or bound function reveals nothing — `[native code]` has no parameter
 * list to read, and skipping it before either parse keeps two thrown acorn
 * exceptions off the hot path for `.transform(Number)` and friends.
 */
function recoverSignature(source: string): FunctionNode | null {
  if (source.includes("[native code]")) return null;
  try {
    const ast = parseExpressionAt(source, 0, { ecmaVersion: "latest", sourceType: "module" });
    const fnNode = asFunctionNode(ast, source);
    if (fnNode !== null) return fnNode;
  } catch {
    // Not an expression on its own; try the object-literal form below.
  }
  try {
    const wrapped = `({${source}})`;
    const ast = parseExpressionAt(wrapped, 0, { ecmaVersion: "latest", sourceType: "module" });
    // Same full-consumption rule asFunctionNode applies: a source that closes
    // the wrapper early and reopens it would otherwise yield the WRONG method's
    // parameter list. Acorn returns the inner object expression, so the only
    // text that may remain is the wrapper's own closing paren.
    if (wrapped.slice(ast.end).trim() !== ")") return null;
    const properties = (ast as Node & { properties?: (Node & { value?: Node })[] }).properties;
    if (properties?.length !== 1) return null;
    const value = properties[0]?.value;
    return value !== undefined && value.type === "FunctionExpression"
      ? (value as FunctionNode)
      : null;
  } catch {
    return null;
  }
}

/**
 * Does a body reference ITS OWN `arguments`?
 *
 * A nested non-arrow function gets a fresh `arguments` binding, so its use of
 * the name says nothing about the callback being classified — descending into
 * one would fail a perfectly safe callback and cost it its compiled path. An
 * arrow has no `arguments` of its own and so is walked.
 */
function referencesOwnArguments(node: Node): boolean {
  if (node.type === "Identifier") return (node as Node & { name: string }).name === "arguments";
  if (node.type === "FunctionExpression" || node.type === "FunctionDeclaration") return false;
  // `obj.arguments` and `{ arguments: v }` name a property, not the binding —
  // the same positions collectIdentifierRefs skips.
  if (node.type === "MemberExpression") {
    const member = node as Node & { object: Node; property: Node; computed: boolean };
    if (referencesOwnArguments(member.object)) return true;
    return member.computed && referencesOwnArguments(member.property);
  }
  if (node.type === "Property") {
    const property = node as Node & { key: Node; value: Node; computed: boolean };
    if (property.computed && referencesOwnArguments(property.key)) return true;
    return referencesOwnArguments(property.value);
  }
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = (node as unknown as Record<string, unknown>)[key];
    if (!child || typeof child !== "object") continue;
    const children = Array.isArray(child) ? child : [child];
    for (const item of children) {
      if (item && typeof item === "object" && "type" in item) {
        if (referencesOwnArguments(item as Node)) return true;
      }
    }
  }
  return false;
}

/**
 * The three ways a parsed signature can betray zod's second argument. Shared so
 * that {@link observesSecondArgument} and {@link isContextFreeUnaryCallback},
 * which are exact inverses of it, cannot drift apart.
 */
function signatureObservesSecondArgument(fnNode: FunctionNode): boolean {
  const params = fnNode.params ?? [];
  if (params.length > 1) return true;
  if (params.some((param) => param.type === "RestElement")) return true;
  return fnNode.body !== undefined && referencesOwnArguments(fnNode.body);
}

/**
 * Does this callback DEMONSTRABLY observe zod's second (parse-context) argument?
 *
 * Only a positive answer is trustworthy. Zod calls `transform(value, payload)`
 * while every compiled route passes the value alone, so a callback that reads
 * the second argument must be left to zod — but a callback whose signature
 * cannot be read (a native like `Number`, a bound function) is NOT thereby
 * suspect, and refusing those costs a very common idiom its compiled path for
 * no correctness gain: `.transform(Number)` delegating measured SLOWER than not
 * compiling at all. So this reports only what the parsed parameter list proves.
 *
 * `fn.length` cannot answer this at all: it stops counting at the first default
 * and ignores a rest element, so `(...args) => args.length` reports 0 and
 * `(v, ctx = null) => …` reports 1.
 */
export function observesSecondArgument(fn: unknown): boolean {
  if (typeof fn !== "function") return false;
  const fnNode = recoverSignature(fn.toString());
  return fnNode !== null && signatureObservesSecondArgument(fnNode);
}

/**
 * Can a callback be invoked with the value alone without hiding Zod's second
 * parse-context argument? `fn.length` is insufficient here: default and rest
 * parameters can observe that argument while still reporting length 0 or 1.
 */
export function isContextFreeUnaryCallback(fn: unknown): boolean {
  if (!isReferenceablePredicate(fn)) return false;
  const source = (fn as Function).toString();
  let ast: Node;
  try {
    ast = parseExpressionAt(source, 0, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch {
    return false;
  }
  const fnNode = asFunctionNode(ast, source);
  if (fnNode === null) return false;
  return !signatureObservesSecondArgument(fnNode);
}

/**
 * A `superRefine`: a `custom` check whose callback takes zod's PAYLOAD rather
 * than the value, collecting issues instead of returning a verdict. Zod stores
 * it on the check instance (`_zod.check`) rather than `def.fn`.
 *
 * Narrowed to zod's OWN wrapper, which is what `_superRefine` builds and the
 * only thing whose payload handling is modelled here: it installs `addIssue`,
 * so every issue the user adds has been through `util.issue`. The trait marks a
 * genuine `$ZodCheck` instance and so excludes a raw `.check(fn)` — shape-
 * identical, but there the callback IS the user's, holding the payload
 * unmediated. A `when` predicate is likewise refused: it makes zod run the
 * check conditionally, where generated code runs it always.
 */
export function isPayloadCheck(check: {
  _zod?: { check?: unknown; def?: { fn?: unknown; when?: unknown }; traits?: Set<string> };
}): boolean {
  return (
    check._zod?.def?.fn === undefined &&
    check._zod?.def?.when === undefined &&
    typeof check._zod?.check === "function" &&
    check._zod?.traits?.has("$ZodCheck") === true
  );
}

/**
 * Try to compile a function into an inlineable source string.
 * Returns the function source if it's a zero-capture function (safe to inline),
 * or undefined if it cannot be compiled (async, has captures, or parse failure).
 */
export function tryCompileEffect(fn: unknown): string | undefined {
  if (typeof fn !== "function") return undefined;

  const source = fn.toString();

  // Quick reject: native functions
  if (source.includes("[native code]")) return undefined;

  let ast: Node;
  try {
    ast = parseExpressionAt(source, 0, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch {
    // Parse failed — likely TypeScript annotations or unsupported syntax
    return undefined;
  }

  // Only a fully-consumed arrow or function expression can be re-emitted as
  // source; see asFunctionNode for the shapes acorn otherwise accepts.
  const fnNode = asFunctionNode(ast, source);
  if (fnNode === null) return undefined;

  // Reject async and generator functions
  if ("async" in ast && (ast as { async?: boolean }).async) return undefined;
  if ("generator" in ast && (ast as { generator?: boolean }).generator) return undefined;

  // Collect parameter names
  const params = new Set<string>();

  // Reject functions with 2+ required parameters (uses Zod ctx argument).
  // transform(value, ctx) and superRefine(value, ctx) rely on ctx for
  // issue collection, which cannot be reproduced in compiled output.
  // fn.length counts parameters before the first default, so (v, base=10)
  // has length 1 (allowed) while (v, ctx) has length 2 (rejected).
  if ((fn as { length: number }).length >= 2) return undefined;

  if (fnNode.params) {
    for (const param of fnNode.params) {
      collectBindingNames(param, params);
    }
  }

  // Collect local variable declarations in the body
  const locals = new Set<string>();
  if (fnNode.body && fnNode.body.type === "BlockStatement") {
    collectLocals(fnNode.body, locals);
  }

  // Collect all identifier references in the body
  const refs = new Set<string>();
  if (fnNode.body) {
    collectIdentifierRefs(fnNode.body, refs);
  }

  // Check for external captures
  for (const ref of refs) {
    if (!params.has(ref) && !locals.has(ref) && !SAFE_GLOBALS.has(ref)) {
      return undefined; // Has external capture
    }
  }

  return source;
}

/** Collect binding names from a parameter pattern (handles destructuring). */
function collectBindingNames(node: Node, names: Set<string>): void {
  switch (node.type) {
    case "Identifier":
      names.add((node as Node & { name: string }).name);
      break;
    case "AssignmentPattern":
      collectBindingNames((node as Node & { left: Node }).left, names);
      break;
    case "ObjectPattern":
      for (const prop of (node as Node & { properties: Node[] }).properties) {
        if (prop.type === "RestElement") {
          collectBindingNames((prop as Node & { argument: Node }).argument, names);
        } else {
          collectBindingNames((prop as Node & { value: Node }).value, names);
        }
      }
      break;
    case "ArrayPattern":
      for (const elem of (node as Node & { elements: (Node | null)[] }).elements) {
        if (elem) collectBindingNames(elem, names);
      }
      break;
    case "RestElement":
      collectBindingNames((node as Node & { argument: Node }).argument, names);
      break;
  }
}

/** Collect locally declared variable names from a block body. */
function collectLocals(body: Node, locals: Set<string>): void {
  const block = body as Node & { body: Node[] };
  if (!block.body) return;
  for (const stmt of block.body) {
    if (stmt.type === "VariableDeclaration") {
      for (const decl of (stmt as Node & { declarations: Node[] }).declarations) {
        const id = (decl as Node & { id: Node }).id;
        collectBindingNames(id, locals);
      }
    }
  }
}

/** Collect all identifier references in an AST subtree. */
function collectIdentifierRefs(node: Node, refs: Set<string>): void {
  if (node.type === "Identifier") {
    refs.add((node as Node & { name: string }).name);
    return;
  }

  // `this` in arrow functions captures from enclosing scope — treat as external capture
  if (node.type === "ThisExpression") {
    refs.add("this");
    return;
  }

  // Skip property access identifiers (obj.prop — "prop" is not a reference)
  if (node.type === "MemberExpression") {
    const member = node as Node & { object: Node; property: Node; computed: boolean };
    collectIdentifierRefs(member.object, refs);
    if (member.computed) {
      collectIdentifierRefs(member.property, refs);
    }
    return;
  }

  // Object literal properties: skip non-computed keys, only walk values
  if (node.type === "Property") {
    const prop = node as Node & { key: Node; value: Node; computed: boolean };
    if (prop.computed) {
      collectIdentifierRefs(prop.key, refs);
    }
    collectIdentifierRefs(prop.value, refs);
    return;
  }

  // Skip binding positions in variable declarations, function params, etc.
  if (node.type === "VariableDeclarator") {
    const decl = node as Node & { init: Node | null };
    if (decl.init) collectIdentifierRefs(decl.init, refs);
    return;
  }

  // Recursively walk all child nodes
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = (node as unknown as Record<string, unknown>)[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && "type" in item) {
            collectIdentifierRefs(item as Node, refs);
          }
        }
      } else if ("type" in child) {
        collectIdentifierRefs(child as Node, refs);
      }
    }
  }
}
