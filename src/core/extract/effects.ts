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

  // Reject async and generator functions
  if ("async" in ast && (ast as { async?: boolean }).async) return undefined;
  if ("generator" in ast && (ast as { generator?: boolean }).generator) return undefined;

  // Collect parameter names
  const params = new Set<string>();
  const fnNode = ast as {
    type: string;
    params?: Node[];
    body?: Node;
  };

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
