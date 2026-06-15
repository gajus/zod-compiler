/**
 * Schema diagnostic utilities for the `check` command.
 * Walks SchemaIR in a single pass and collects per-node diagnostic info.
 */

import type { SchemaIR } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type NodeStatus = "compiled" | "fallback";

export interface DiagnosticNode {
  /** SchemaIR type (e.g. "string", "object", "fallback") */
  type: string;
  /** Dot-separated path from root (e.g. ".name", ".addresses[]") */
  path: string;
  /** Whether this node is compiled or falls back to Zod */
  status: NodeStatus;
  /** Fallback reason when status is "fallback" */
  reason?: string;
  /** Actionable hint for fixing the fallback */
  hint?: string;
  /** Child diagnostic nodes */
  children: DiagnosticNode[];
}

export interface DiagnosticResult {
  /** Root diagnostic tree */
  root: DiagnosticNode;
  /** Total leaf node count */
  total: number;
  /** Number of compiled leaf nodes */
  compilable: number;
  /** Coverage percentage (0-100) */
  coveragePct: number;
  /** Whether the schema is eligible for Fast Path */
  fastPathEligible: boolean;
  /** Reason Fast Path is ineligible (when fastPathEligible is false) */
  fastPathBlocker?: string;
  /** Flat list of fallback entries for summary display */
  fallbacks: { reason: string; path: string; hint: string }[];
}

// ─── Fast Path Eligibility ──────────────────────────────────────────────────

/** Schema types that block Fast Path eligibility. */
const FAST_PATH_BLOCKERS = new Set<string>(["fallback", "effect", "stringBool"]);

/** Check if a single node blocks Fast Path (without recursing). */
function detectFastPathBlocker(ir: SchemaIR): string | null {
  if (FAST_PATH_BLOCKERS.has(ir.type)) {
    return ir.type === "fallback" ? `fallback (${(ir as { reason: string }).reason})` : ir.type;
  }
  if ("coerce" in ir && ir.coerce) {
    return `coerce (${ir.type})`;
  }
  // Value-mutating string checks make the schema slow-path only: overwrite
  // effects (.trim()/.toLowerCase()) rewrite the value and url checks trim it,
  // while the fast path returns input unchanged.
  if (ir.type === "string") {
    for (const check of ir.checks) {
      if (check.kind === "overwrite_effect") return "overwrite (.trim()/.toLowerCase())";
      if (check.kind === "string_format" && check.format === "url") return "url (trims value)";
    }
  }
  return null;
}

// ─── Hint Generation ────────────────────────────────────────────────────────

const FALLBACK_HINTS: Record<string, string> = {
  transform: "Extract transform into a separate post-processing step",
  refine: "Replace .refine() with built-in checks (e.g. .min(), .max(), .regex())",
  superRefine: "Replace .superRefine() with built-in checks if possible",
  custom: "Replace z.custom() with a supported schema type",
  lazy: "Ensure the lazy getter resolves to a static schema (recursion compiles automatically)",
  unsupported: "This schema type is not yet supported by zod-compiler",
  coalesced:
    "Every property falls back to Zod, so the whole object is delegated once (faster than per-field delegation)",
};

function getHint(reason: string): string {
  return FALLBACK_HINTS[reason] ?? "Check zod-compiler documentation for supported schemas";
}

// ─── Child Iteration (with path computation) ───────────────────────────────

/** Yields [childPath, childIR] pairs for a given SchemaIR node. */
function* iterChildren(ir: SchemaIR, parentPath: string): Generator<[string, SchemaIR]> {
  switch (ir.type) {
    case "object":
      for (const [key, child] of Object.entries(ir.properties)) {
        yield [`${parentPath}.${key}`, child];
      }
      break;
    case "array":
      yield [`${parentPath}[]`, ir.element];
      break;
    case "tuple":
      for (const [i, item] of ir.items.entries()) {
        yield [`${parentPath}[${i}]`, item];
      }
      if (ir.rest) yield [`${parentPath}[...rest]`, ir.rest];
      break;
    case "record":
      yield [`${parentPath}[key]`, ir.keyType];
      yield [`${parentPath}[value]`, ir.valueType];
      break;
    case "set":
      yield [`${parentPath}[element]`, ir.valueType];
      break;
    case "map":
      yield [`${parentPath}[key]`, ir.keyType];
      yield [`${parentPath}[value]`, ir.valueType];
      break;
    case "union":
    case "discriminatedUnion":
      for (const [i, opt] of ir.options.entries()) {
        yield [`${parentPath}[${i}]`, opt];
      }
      break;
    case "intersection":
      yield [`${parentPath}[left]`, ir.left];
      yield [`${parentPath}[right]`, ir.right];
      break;
    case "optional":
    case "nullable":
    case "readonly":
      yield [parentPath, ir.inner];
      break;
    case "default":
    case "catch":
      yield [parentPath, ir.inner];
      break;
    case "pipe":
      yield [`${parentPath}[in]`, ir.in];
      yield [`${parentPath}[out]`, ir.out];
      break;
    case "effect":
      yield [`${parentPath}[inner]`, ir.inner];
      break;
    case "recursionTarget":
      // Transparent wrapper around a non-root recursive sub-schema: descend so
      // coverage and any inner fallbacks are reported at the same path.
      yield [parentPath, ir.inner];
      break;
  }
}

// ─── Single-Pass Diagnostic Walker ──────────────────────────────────────────

interface WalkResult {
  node: DiagnosticNode;
  total: number;
  compilable: number;
  fallbacks: { reason: string; path: string; hint: string }[];
  /** First Fast Path blocker found in this subtree, or null if eligible. */
  fastPathBlocker: string | null;
}

function walkIR(ir: SchemaIR, currentPath: string): WalkResult {
  // Fallback leaf
  if (ir.type === "fallback") {
    const hint = getHint(ir.reason);
    const nodePath = currentPath || "(root)";
    return {
      node: {
        type: ir.type,
        path: nodePath,
        status: "fallback",
        reason: ir.reason,
        hint,
        children: [],
      },
      total: 1,
      compilable: 0,
      fallbacks: [{ reason: ir.reason, path: nodePath, hint }],
      fastPathBlocker: `fallback (${ir.reason})`,
    };
  }

  // Check if this node itself blocks Fast Path
  let fastPathBlocker = detectFastPathBlocker(ir);

  // Recurse into children
  const children: DiagnosticNode[] = [];
  let total = 0;
  let compilable = 0;
  const fallbacks: { reason: string; path: string; hint: string }[] = [];

  for (const [childPath, child] of iterChildren(ir, currentPath)) {
    const r = walkIR(child, childPath);
    children.push(r.node);
    total += r.total;
    compilable += r.compilable;
    fallbacks.push(...r.fallbacks);
    if (fastPathBlocker === null && r.fastPathBlocker !== null) {
      fastPathBlocker = r.fastPathBlocker;
    }
  }

  // Leaf node (no children produced by iterChildren)
  if (children.length === 0) {
    total = 1;
    compilable = 1;
  }

  return {
    node: {
      type: ir.type,
      path: currentPath || "(root)",
      status: "compiled",
      children,
    },
    total,
    compilable,
    fallbacks,
    fastPathBlocker,
  };
}

/**
 * Diagnose a SchemaIR in a single pass.
 * Returns a diagnostic tree with coverage stats, Fast Path eligibility, and actionable hints.
 */
export function diagnoseSchema(ir: SchemaIR): DiagnosticResult {
  const { node: root, total, compilable, fallbacks, fastPathBlocker } = walkIR(ir, "");
  const coveragePct = total > 0 ? Math.round((compilable / total) * 100) : 100;

  const result: DiagnosticResult = {
    root,
    total,
    compilable,
    coveragePct,
    fastPathEligible: fastPathBlocker === null,
    fallbacks,
  };
  if (fastPathBlocker !== null) {
    result.fastPathBlocker = fastPathBlocker;
  }
  return result;
}
