import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AnyNode,
  AssignmentExpression,
  Expression,
  Program,
  Statement,
  VariableDeclaration,
} from "acorn";
import { parse } from "acorn";
import type { Jiti } from "jiti";

/**
 * Static pre-filter: decide whether a source file could export Zod schemas
 * WITHOUT executing it.
 *
 * Discovery executes candidate files (and, transitively, their whole import
 * graph) to scan exports. In autoDiscover mode most files that import zod
 * only export functions, components, or constants — executing them is pure
 * waste. This filter transpiles the single file (no dependencies) with
 * jiti's transform and inspects the top-level exports of the resulting
 * CommonJS with acorn.
 *
 * Conservative by construction: it returns false ("skip") only when every
 * export is statically provable as a non-schema (function, class, arrow,
 * literal, ...). Anything unrecognized — call expressions, re-exports,
 * `export *`, dynamic patterns, transpile/parse failures — keeps the file a
 * candidate, so a filter miss costs one execution, never a schema.
 */

type Classification = "safe" | "candidate";

/** Lazily created jiti instance used only for single-file transpilation. */
let transformerPromise: Promise<Jiti> | undefined;

function getTransformer(): Promise<Jiti> {
  transformerPromise ??= import("jiti").then(({ createJiti }) =>
    createJiti(pathToFileURL(path.resolve("__zod-compiler-static-filter__.mjs")).href),
  );
  return transformerPromise;
}

/**
 * Check whether a file's exports could include Zod schemas (or compile()
 * results) without executing the file. `filename` selects the TS/JSX
 * transforms; the file does not need to exist on disk.
 */
export async function mayExportSchemas(code: string, filename: string): Promise<boolean> {
  let transpiled: string;
  try {
    const jiti = await getTransformer();
    transpiled = jiti.transform({
      source: code,
      filename,
      ts: /\.[cm]?tsx?$/.test(filename),
      jsx: /\.[cm]?[jt]sx$/.test(filename),
      // async mode keeps top-level await and emits `await jitiImport(...)`
      // instead of failing — statements stay top-level either way.
      async: true,
    });
  } catch {
    return true;
  }
  // jiti reports parse failures by embedding an error marker in the output
  // instead of throwing. We can't analyze such files — keep them candidates
  // so the real loader surfaces (or tolerates) the failure exactly as before.
  if (transpiled.includes("__JITI_ERROR__")) return true;

  let program: Program;
  try {
    // Module mode: the CJS output has no import/export statements, but may
    // contain top-level await (async transform).
    program = parse(transpiled, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return true;
  }

  return analyzeProgram(program);
}

/** Where an assignment target sends its value, in discovery terms. */
type ExportTarget =
  | { kind: "named"; name: string }
  | { kind: "default" }
  | { kind: "local"; name: string }
  | { kind: "ignored" }
  | { kind: "unknown" };

function analyzeProgram(program: Program): boolean {
  // Pass 1: top-level bindings for identifier resolution, plus the set of
  // identifier nodes that are "expected" (declaration ids and exports-chain
  // participants). Pass 2 counts every OTHER reference: a name referenced
  // outside its declaration/export may be mutated after creation
  // (defineProperty, member writes, helper calls), so object/array values
  // it names cannot be proven schema-free.
  const safeDecls = new Set<string>();
  const varInits = new Map<string, Expression | null>();
  const expectedNodes = new Set<object>();

  function recordChainNodes(expr: Expression): void {
    let node = expr;
    let hasExportTarget = false;
    while (node.type === "AssignmentExpression" && node.operator === "=") {
      if (node.left.type === "Identifier") {
        // Assignment LHS identifiers rebind — they never read the value.
        expectedNodes.add(node.left);
      } else if (node.left.type === "MemberExpression" && mentionsExports(node.left)) {
        hasExportTarget = true;
      }
      node = node.right;
    }
    // The bare-identifier value of an export chain (`exports.f = f`) is the
    // export itself; in a plain local chain (`alias = obj`) it is a real
    // aliasing reference and must count toward taint.
    if (hasExportTarget && node.type === "Identifier") expectedNodes.add(node);
  }

  for (const stmt of program.body) {
    if (stmt.type === "FunctionDeclaration" || stmt.type === "ClassDeclaration") {
      safeDecls.add(stmt.id.name);
      expectedNodes.add(stmt.id);
    } else if (stmt.type === "VariableDeclaration") {
      for (const decl of stmt.declarations) {
        if (decl.id.type === "Identifier") {
          expectedNodes.add(decl.id);
          // The init may be an `exports.X = value` chain — resolution should
          // see the final value expression.
          varInits.set(decl.id.name, decl.init ? unwrapAssignmentChain(decl.init).value : null);
        }
        if (decl.init) recordChainNodes(decl.init);
      }
    } else if (stmt.type === "ExpressionStatement") {
      recordChainNodes(stmt.expression);
    }
  }

  const referencedNames = collectReferencedNames(program, expectedNodes);

  function resolveIdentifier(name: string, defaultish: boolean, seen: Set<string>): Classification {
    if (seen.has(name)) return "candidate";
    seen.add(name);
    if (safeDecls.has(name)) return "safe";
    const init = varInits.get(name);
    if (init === undefined || init === null) return "candidate";
    return classifyValue(init, defaultish, seen, [name]);
  }

  /**
   * Could this expression evaluate to a Zod schema (an object carrying
   * `_zod.def` or the compile() marker)? `bindingNames` are the local
   * aliases of the value — a mutable container (object/array) is only safe
   * when none of its aliases are referenced elsewhere in the file.
   */
  function classifyValue(
    node: Expression,
    defaultish: boolean,
    seen: Set<string>,
    bindingNames: readonly string[],
  ): Classification {
    switch (node.type) {
      case "Literal":
      case "TemplateLiteral":
      case "ArrowFunctionExpression":
      case "FunctionExpression":
      case "ClassExpression":
      case "UnaryExpression":
      case "UpdateExpression":
      case "BinaryExpression":
        return "safe";
      case "ObjectExpression":
      case "ArrayExpression":
        // Discovery unwraps the properties of a default export object (and
        // arrays are objects), so containers are candidates there. Named
        // export containers are never unwrapped — but a container whose
        // alias is referenced elsewhere may be mutated into a schema shape.
        if (defaultish) return "candidate";
        return bindingNames.some((n) => referencedNames.has(n)) ? "candidate" : "safe";
      case "Identifier":
        return resolveIdentifier(node.name, defaultish, seen);
      case "ConditionalExpression":
        return classifyValue(node.consequent, defaultish, seen, bindingNames) === "safe" &&
          classifyValue(node.alternate, defaultish, seen, bindingNames) === "safe"
          ? "safe"
          : "candidate";
      case "LogicalExpression":
        return classifyValue(node.left, defaultish, seen, bindingNames) === "safe" &&
          classifyValue(node.right, defaultish, seen, bindingNames) === "safe"
          ? "safe"
          : "candidate";
      case "SequenceExpression": {
        const last = node.expressions[node.expressions.length - 1];
        return last ? classifyValue(last, defaultish, seen, bindingNames) : "candidate";
      }
      case "AssignmentExpression":
        return classifyValue(unwrapAssignmentChain(node).value, defaultish, seen, bindingNames);
      default:
        // CallExpression, NewExpression, MemberExpression, AwaitExpression, ...
        return "candidate";
    }
  }

  /** Process one assignment chain: classify the value for each export target. */
  function processAssignment(expr: Expression, declaredName?: string): Classification {
    const { targets, value } = unwrapAssignmentChain(expr);
    const bindingNames: string[] = declaredName ? [declaredName] : [];
    const exportTargets: ExportTarget[] = [];
    for (const target of targets) {
      const exportTarget = exportTargetOf(target);
      if (exportTarget.kind === "unknown") return "candidate";
      if (exportTarget.kind === "local") bindingNames.push(exportTarget.name);
      exportTargets.push(exportTarget);
    }
    for (const exportTarget of exportTargets) {
      if (exportTarget.kind === "named") {
        if (classifyValue(value, false, new Set(), bindingNames) === "candidate")
          return "candidate";
      } else if (exportTarget.kind === "default") {
        if (classifyValue(value, true, new Set(), bindingNames) === "candidate") return "candidate";
      }
    }
    // Catch-all: the value itself may reference exports in a shape we did
    // not positively classify (e.g. `exports.a = fn(exports.b)`).
    return mentionsExports(value) ? "candidate" : "safe";
  }

  function processVariableDeclaration(stmt: VariableDeclaration): Classification {
    for (const decl of stmt.declarations) {
      if (!decl.init) continue;
      if (decl.id.type === "Identifier") {
        if (processAssignment(decl.init, decl.id.name) === "candidate") return "candidate";
      } else if (mentionsExports(decl.init)) {
        // Destructuring declarators don't export by themselves (babel emits
        // separate `exports.x = x` statements), but be paranoid about any
        // exports reference hiding inside.
        return "candidate";
      }
    }
    return "safe";
  }

  function processStatement(stmt: Statement): Classification {
    switch (stmt.type) {
      case "FunctionDeclaration":
      case "ClassDeclaration":
        // Bodies that touch exports (hand-written CJS patterns) are opaque.
        return mentionsExports(stmt) ? "candidate" : "safe";
      case "VariableDeclaration":
        return processVariableDeclaration(stmt);
      case "ExpressionStatement":
        return processExpression(stmt.expression);
      case "EmptyStatement":
        return "safe";
      default:
        // if/try/for/... — babel never emits exports there for ESM input,
        // but hand-written CJS might (`if (x) module.exports = ...`).
        return mentionsExports(stmt) ? "candidate" : "safe";
    }
  }

  function processExpression(expr: Expression): Classification {
    switch (expr.type) {
      case "Literal":
        // Directive prologue ("use strict")
        return "safe";
      case "AssignmentExpression":
        return processAssignment(expr);
      case "SequenceExpression": {
        for (const sub of expr.expressions) {
          if (processExpression(sub) === "candidate") return "candidate";
        }
        return "safe";
      }
      case "CallExpression":
        if (isEsModuleMarker(expr)) return "safe";
        // Other exports-touching calls: re-export getters
        // (Object.defineProperty), `export *` loops, helpers.
        return mentionsExports(expr) ? "candidate" : "safe";
      default:
        return mentionsExports(expr) ? "candidate" : "safe";
    }
  }

  for (const stmt of program.body) {
    // The CJS output of jiti's transform contains no module declarations,
    // but if one ever appears, treat the file as a candidate.
    if (!isStatement(stmt)) return true;
    if (processStatement(stmt) === "candidate") return true;
  }
  return false;
}

function isStatement(node: AnyNode): node is Statement {
  return !node.type.startsWith("Import") && !node.type.startsWith("Export");
}

/**
 * Unwrap `a = b = c = value` into its assignment targets and final value.
 * Non-assignment expressions return zero targets and themselves as value.
 */
function unwrapAssignmentChain(expr: Expression): {
  targets: AssignmentExpression["left"][];
  value: Expression;
} {
  const targets: AssignmentExpression["left"][] = [];
  let value = expr;
  while (value.type === "AssignmentExpression" && value.operator === "=") {
    targets.push(value.left);
    value = value.right;
  }
  return { targets, value };
}

/** Classify an assignment target by what discovery would see. */
function exportTargetOf(target: AssignmentExpression["left"]): ExportTarget {
  if (target.type === "Identifier") {
    if (target.name === "exports" || target.name === "module") return { kind: "unknown" };
    return { kind: "local", name: target.name };
  }
  if (target.type !== "MemberExpression") {
    return mentionsExports(target) ? { kind: "unknown" } : { kind: "ignored" };
  }
  const propName =
    !target.computed && target.property.type === "Identifier"
      ? target.property.name
      : target.computed && target.property.type === "Literal"
        ? String(target.property.value)
        : null;

  // exports.X = ...
  if (target.object.type === "Identifier" && target.object.name === "exports") {
    if (propName === null) return { kind: "unknown" };
    return propName === "default" ? { kind: "default" } : { kind: "named", name: propName };
  }
  // module.exports = ... behaves like a default export after interop:
  // discovery unwraps its properties.
  if (target.object.type === "Identifier" && target.object.name === "module") {
    return propName === "exports" ? { kind: "default" } : { kind: "unknown" };
  }
  // module.exports.X = ...
  if (
    target.object.type === "MemberExpression" &&
    target.object.object.type === "Identifier" &&
    target.object.object.name === "module" &&
    !target.object.computed &&
    target.object.property.type === "Identifier" &&
    target.object.property.name === "exports"
  ) {
    if (propName === null) return { kind: "unknown" };
    return propName === "default" ? { kind: "default" } : { kind: "named", name: propName };
  }
  return mentionsExports(target) ? { kind: "unknown" } : { kind: "ignored" };
}

/** Object.defineProperty(exports, "__esModule", { value: true }) */
function isEsModuleMarker(expr: Expression): boolean {
  return (
    expr.type === "CallExpression" &&
    expr.callee.type === "MemberExpression" &&
    expr.callee.object.type === "Identifier" &&
    expr.callee.object.name === "Object" &&
    !expr.callee.computed &&
    expr.callee.property.type === "Identifier" &&
    expr.callee.property.name === "defineProperty" &&
    expr.arguments[0]?.type === "Identifier" &&
    expr.arguments[0].name === "exports" &&
    expr.arguments[1]?.type === "Literal" &&
    expr.arguments[1].value === "__esModule"
  );
}

/**
 * Collect every identifier name used in a reference position, excluding the
 * `expected` nodes (declaration ids and exports-chain participants).
 * Non-reference positions — non-computed member properties, non-computed
 * object/class keys, labels — are skipped. Over-counting (e.g. shadowed
 * names in nested scopes, function params) only makes the filter more
 * conservative, never less safe.
 */
function collectReferencedNames(program: Program, expected: Set<object>): Set<string> {
  const names = new Set<string>();
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    const type = record["type"];
    if (typeof type !== "string") continue;

    if (type === "Identifier") {
      if (!expected.has(node)) names.add(record["name"] as string);
      continue;
    }

    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== "object" || value === null) continue;
      // Skip non-reference identifier positions.
      if (key === "property" && type === "MemberExpression" && record["computed"] !== true)
        continue;
      if (
        key === "key" &&
        (type === "Property" || type === "PropertyDefinition" || type === "MethodDefinition") &&
        record["computed"] !== true
      )
        continue;
      if (key === "label") continue;
      stack.push(value);
    }
  }
  return names;
}

/** Deep-walk an acorn node for any reference to `exports` or `module`. */
function mentionsExports(root: object): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    if (typeof record["type"] === "string") {
      if (
        record["type"] === "Identifier" &&
        (record["name"] === "exports" || record["name"] === "module")
      ) {
        return true;
      }
    }
    for (const value of Object.values(record)) {
      if (typeof value === "object" && value !== null) stack.push(value);
    }
  }
  return false;
}
