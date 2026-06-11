import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { DiagnosticNode, DiagnosticResult } from "#src/core/diagnostic.js";
import { diagnoseSchema } from "#src/core/diagnostic.js";
import { extractSchema } from "#src/core/extract/index.js";
import type { DiscoveredSchema, SchemaIR } from "#src/core/types.js";
import { discoverSchemas } from "#src/discovery.js";
import { getErrorMessage } from "../errors.js";
import type { Colors } from "../logger.js";
import { createColors, logger } from "../logger.js";

// ─── Tree Rendering ─────────────────────────────────────────────────────────

function renderTree(node: DiagnosticNode, c: Colors, prefix = "", isLast = true): string[] {
  const lines: string[] = [];
  const connector = prefix === "" ? "" : isLast ? "└─ " : "├─ ";
  const childPrefix = prefix === "" ? "" : prefix + (isLast ? "   " : "│  ");

  const statusIcon = node.status === "compiled" ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
  const typeLabel = `${c.bold}${node.type}${c.reset}`;
  const pathLabel = node.path && node.path !== "(root)" ? ` ${c.dim}${node.path}${c.reset}` : "";
  const reasonLabel =
    node.status === "fallback" && node.reason ? ` ${c.yellow}(${node.reason})${c.reset}` : "";

  lines.push(`${prefix}${connector}${statusIcon} ${typeLabel}${pathLabel}${reasonLabel}`);

  if (node.status === "fallback" && node.hint) {
    const hintPrefix = `${childPrefix}   `;
    lines.push(`${hintPrefix}${c.dim}hint: ${node.hint}${c.reset}`);
  }

  for (const [i, child] of node.children.entries()) {
    const last = i === node.children.length - 1;
    lines.push(...renderTree(child, c, childPrefix, last));
  }

  return lines;
}

// ─── JSON Output ────────────────────────────────────────────────────────────

interface JsonSchemaReport {
  exportName: string;
  coverage: { total: number; compilable: number; percent: number };
  fastPath: { eligible: boolean; blocker?: string };
  fallbacks: { reason: string; path: string; hint: string }[];
}

interface JsonReport {
  file: string;
  schemas: JsonSchemaReport[];
}

function buildJsonReport(
  filePath: string,
  results: { exportName: string; diagnostic: DiagnosticResult }[],
): JsonReport {
  return {
    file: filePath,
    schemas: results.map(({ exportName, diagnostic }) => {
      const report: JsonSchemaReport = {
        exportName,
        coverage: {
          total: diagnostic.total,
          compilable: diagnostic.compilable,
          percent: diagnostic.coveragePct,
        },
        fastPath: { eligible: diagnostic.fastPathEligible },
        fallbacks: diagnostic.fallbacks,
      };
      if (diagnostic.fastPathBlocker) {
        report.fastPath.blocker = diagnostic.fastPathBlocker;
      }
      return report;
    }),
  };
}

// ─── Command ────────────────────────────────────────────────────────────────

export interface CheckOptions {
  inputs: string[];
  json: boolean;
  failUnder: number | undefined;
  noColor: boolean;
  autoDiscover: boolean;
}

export async function runCheck(options: CheckOptions): Promise<void> {
  // oxlint-disable-next-line no-console -- CLI output
  const out = console.log;
  // oxlint-disable-next-line no-console -- CLI output
  const err = console.error;
  const colorEnabled = !options.noColor && process.stdout.isTTY === true;
  const c = createColors(colorEnabled);
  const files: string[] = [];

  for (const input of options.inputs) {
    const absPath = path.resolve(input);
    const stat = await fs.promises.stat(absPath).catch(() => null);

    if (!stat) {
      logger.error(`File not found: ${input}`);
      process.exit(1);
    }

    if (stat.isDirectory()) {
      logger.error("check command expects file paths, not directories.");
      process.exit(1);
    }

    files.push(absPath);
  }

  const allJsonReports: JsonReport[] = [];
  let minCoverage = 100;
  let schemasProcessed = 0;

  for (const filePath of files) {
    const relPath = path.relative(process.cwd(), filePath);

    let schemas: DiscoveredSchema[];
    try {
      schemas = await discoverSchemas(filePath, { autoDiscover: options.autoDiscover });
    } catch (e) {
      logger.error(`Failed to load ${relPath}: ${getErrorMessage(e)}`);
      process.exit(1);
    }

    if (schemas.length === 0) {
      const hint = options.autoDiscover
        ? "no Zod schemas exported"
        : "no compile() calls found (use --auto-discover to scan plain Zod exports)";
      logger.warn(`${relPath}: ${hint}`);
      continue;
    }

    const results: { exportName: string; diagnostic: DiagnosticResult }[] = [];

    for (const s of schemas) {
      let ir: SchemaIR;
      try {
        ir = extractSchema(s.schema);
      } catch (e) {
        err(
          `${c.red}error${c.reset} Failed to extract "${s.exportName}" in ${relPath}: ${getErrorMessage(e)}`,
        );
        continue;
      }
      const diagnostic = diagnoseSchema(ir);
      results.push({ exportName: s.exportName, diagnostic });
      schemasProcessed++;

      if (diagnostic.coveragePct < minCoverage) {
        minCoverage = diagnostic.coveragePct;
      }
    }

    if (options.json) {
      allJsonReports.push(buildJsonReport(relPath, results));
    } else {
      out(`\n${c.bold}${relPath}${c.reset}`);

      for (const { exportName, diagnostic } of results) {
        const pctColor = diagnostic.coveragePct === 100 ? c.green : c.yellow;
        const fpLabel = diagnostic.fastPathEligible
          ? `${c.green}Fast Path: eligible${c.reset}`
          : `${c.yellow}Fast Path: ineligible${c.reset}${c.dim} (${diagnostic.fastPathBlocker})${c.reset}`;

        out(
          `\n  ${c.cyan}${exportName}${c.reset} — ${pctColor}${diagnostic.coveragePct}%${c.reset} compiled (${diagnostic.compilable}/${diagnostic.total} nodes) | ${fpLabel}`,
        );

        const treeLines = renderTree(diagnostic.root, c, "    ");
        for (const line of treeLines) {
          out(line);
        }

        if (diagnostic.fallbacks.length > 0) {
          out(`\n    ${c.yellow}Fallbacks:${c.reset}`);
          for (const fb of diagnostic.fallbacks) {
            out(`      ${c.red}✗${c.reset} ${fb.path} — ${fb.reason}`);
            out(`        ${c.dim}${fb.hint}${c.reset}`);
          }
        }
      }
    }
  }

  if (options.json) {
    out(JSON.stringify(allJsonReports, null, 2));
  }

  if (options.failUnder !== undefined) {
    if (schemasProcessed === 0) {
      logger.error("No schemas were analyzed — cannot satisfy --fail-under");
      process.exit(1);
    }
    if (minCoverage < options.failUnder) {
      logger.error(`Coverage ${minCoverage}% is below threshold ${options.failUnder}%`);
      process.exit(1);
    }
  } else if (schemasProcessed === 0) {
    process.exit(1);
  }
}
