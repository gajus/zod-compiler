#!/usr/bin/env node

import { createRequire } from "node:module";
import process from "node:process";
import type { CheckOptions } from "./commands/check.js";
import type { GenerateOptions as BaseGenerateOptions } from "./commands/generate.js";
import { getErrorMessage } from "./errors.js";
import { logger } from "./logger.js";

const require = createRequire(import.meta.url);
const VERSION: string = (require("../../package.json") as { version: string }).version;

type GenerateOptions = BaseGenerateOptions & { watch: boolean };

type Command =
  | { kind: "generate"; options: GenerateOptions }
  | { kind: "check"; options: CheckOptions }
  | { kind: "help" }
  | { kind: "version" };

function printUsage(): void {
  // oxlint-disable-next-line no-console -- CLI output
  console.log(
    `
zod-compiler v${VERSION} — Compile Zod schemas into zero-overhead validation functions

Usage:
  zod-compiler generate <files...> [-o <output>] [-w] [--schemas <mode>]
  zod-compiler check <files...> [--json] [--fail-under <pct>] [--no-color] [--schemas <mode>]

Commands:
  generate    Generate optimized validation code from discovered schemas
  check       Check schemas with tree view, coverage, Fast Path status, and hints

Options:
  -o, --output <path>        Output file or directory
  -w, --watch                Watch for changes and regenerate
  --schemas <explicit|auto>  How schemas are found: "auto" (default) compiles every
                             exported Zod schema; "explicit" only compile()-wrapped ones
  --emit <schema|bag>        Compiled export shape: "schema" (default, full Zod API) or
                             "bag" (minimal methods-only object, smaller output)
  --strip-unknown-keys       Strip unknown keys from z.object() output (matches Zod's
                             default .parse(); off by default, generate only)
  --json                     Output diagnosis as JSON (check only)
  --fail-under <pct>         Exit with code 1 if any schema's coverage < pct (check only)
  --no-color                 Disable colored output (check only)
  -h, --help                 Show this help message
  -v, --version              Show version number

Examples:
  zod-compiler generate src/schemas.ts
  zod-compiler generate src/schemas.ts -o src/schemas.compiled.ts
  zod-compiler generate src/ --watch
  zod-compiler generate src/schemas.ts --schemas explicit
  zod-compiler check src/schemas.ts
  zod-compiler check src/schemas.ts --json --fail-under 80
`.trim(),
  );
}

/** Parse a `--schemas <explicit|auto>` value; exits on invalid input. */
function parseSchemasValue(val: string | undefined): boolean {
  if (val !== "explicit" && val !== "auto") {
    logger.error('--schemas must be "explicit" or "auto"');
    process.exit(1);
  }
  return val === "auto";
}

/** Parse an `--emit <schema|bag>` value; exits on invalid input. */
function parseEmitValue(val: string | undefined): boolean {
  if (val !== "schema" && val !== "bag") {
    logger.error('--emit must be "schema" or "bag"');
    process.exit(1);
  }
  return val === "schema";
}

function parseArgs(argv: string[]): Command {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return { kind: "help" };
  }

  if (args.includes("--version") || args.includes("-v")) {
    return { kind: "version" };
  }

  const command = args[0];
  const rest = args.slice(1);

  if (command === "generate") {
    const inputs: string[] = [];
    let output: string | undefined;
    let watch = false;
    let zodCompat: boolean | undefined;
    // Default "auto": every exported Zod schema compiles, matching the plugin.
    let autoDiscover = true;
    let stripUnknownKeys = false;

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "-o" || arg === "--output") {
        i++;
        const val = rest[i];
        if (!val) {
          logger.error("Missing value for --output");
          process.exit(1);
        }
        output = val;
      } else if (arg === "-w" || arg === "--watch") {
        watch = true;
      } else if (arg === "--schemas") {
        i++;
        autoDiscover = parseSchemasValue(rest[i]);
      } else if (arg === "--emit") {
        i++;
        zodCompat = parseEmitValue(rest[i]);
      } else if (arg === "--strip-unknown-keys") {
        stripUnknownKeys = true;
      } else if (arg.startsWith("-")) {
        logger.error(`Unknown option: ${arg}`);
        process.exit(1);
      } else {
        inputs.push(arg);
      }
    }

    if (inputs.length === 0) {
      logger.error("No input files specified. Run 'zod-compiler --help' for usage.");
      process.exit(1);
    }

    return {
      kind: "generate",
      options: {
        inputs,
        output,
        watch,
        zodCompat,
        autoDiscover,
        stripUnknownKeys,
      },
    };
  }

  if (command === "check") {
    const inputs: string[] = [];
    let json = false;
    let failUnder: number | undefined;
    let noColor = false;
    // Default "auto", matching generate and the plugin.
    let autoDiscover = true;

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--json") {
        json = true;
      } else if (arg === "--schemas") {
        i++;
        autoDiscover = parseSchemasValue(rest[i]);
      } else if (arg === "--fail-under") {
        i++;
        const val = rest[i];
        if (!val) {
          logger.error("Missing value for --fail-under");
          process.exit(1);
        }
        const num = Number(val);
        if (Number.isNaN(num) || num < 0 || num > 100) {
          logger.error("--fail-under must be a number between 0 and 100");
          process.exit(1);
        }
        failUnder = num;
      } else if (arg === "--no-color") {
        noColor = true;
      } else if (arg.startsWith("-")) {
        logger.error(`Unknown option: ${arg}`);
        process.exit(1);
      } else {
        inputs.push(arg);
      }
    }

    if (inputs.length === 0) {
      logger.error("No input files specified. Run 'zod-compiler --help' for usage.");
      process.exit(1);
    }

    return { kind: "check", options: { inputs, json, failUnder, noColor, autoDiscover } };
  }

  logger.error(`Unknown command: ${command}. Run 'zod-compiler --help' for usage.`);
  process.exit(1);
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv);

  switch (command.kind) {
    case "help":
      printUsage();
      break;
    case "version":
      // oxlint-disable-next-line no-console -- CLI output
      console.log(VERSION);
      break;
    case "generate": {
      if (command.options.watch) {
        const { runWatch } = await import("./commands/watch.js");
        await runWatch(command.options);
      } else {
        const { runGenerate } = await import("./commands/generate.js");
        await runGenerate(command.options);
      }
      break;
    }
    case "check": {
      const { runCheck } = await import("./commands/check.js");
      await runCheck(command.options);
      break;
    }
  }
}

void main().catch((err: unknown) => {
  logger.error(getErrorMessage(err));
  process.exit(1);
});
