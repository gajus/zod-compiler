/**
 * Size report for the CLI emitter (cli/emitter.ts → .compiled.ts files).
 *
 * Generates compiled output for representative schemas and measures raw + gzip
 * bytes per schema. Mirrors what `npx zod-compiler generate` produces.
 *
 * Run: pnpm size:cli
 */
import { gzipSync } from "node:zlib";
import type { z } from "zod";
import { generateCompiledFileContent } from "../../../src/cli/emitter.js";
import { generateValidator } from "../../../src/core/codegen/index.js";
import type { RefEntry } from "../../../src/core/extract/index.js";
import { extractSchema } from "../../../src/core/extract/index.js";
import type { CompiledSchemaInfo } from "../../../src/core/pipeline.js";
import {
  MapSchema,
  RecordSchema,
  SetSchema,
  TupleSchema,
} from "../../fixtures/schemas/collections/zod.js";
import {
  CapturedTransformSchema,
  ZeroCaptureRefineStringSchema,
  ZeroCaptureTransformStringSchema,
} from "../../fixtures/schemas/effects/zod.js";
import { ApiResponseSchema, UserSchema } from "../../fixtures/schemas/objects/zod.js";
// Zod schemas only (avoid typia/ajv which require build-time transforms)
import {
  BigIntSchema,
  NumberWithChecks,
  SimpleEnum,
  SimpleString,
  StringWithChecks,
} from "../../fixtures/schemas/primitives/zod.js";
import {
  EventLogSchema,
  PartialFallbackObjectSchema,
} from "../../fixtures/schemas/real-world/zod.js";
import { TreeNodeSchema } from "../../fixtures/schemas/recursive/zod.js";
import { DiscriminatedUnionSchema } from "../../fixtures/schemas/unions/zod.js";

function makeInfo(exportName: string, schema: z.ZodType): CompiledSchemaInfo {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const codegenResult = generateValidator(ir, exportName, { refCount: refEntries.length });
  return { exportName, codegenResult, refEntries };
}

function measure(info: CompiledSchemaInfo): { raw: number; gzip: number } {
  const content = generateCompiledFileContent([info], "./schemas.ts", { zodCompat: false });
  return {
    raw: Buffer.byteLength(content, "utf-8"),
    gzip: gzipSync(content).length,
  };
}

const SCHEMAS: Array<{ group: string; name: string; exportName: string; schema: z.ZodType }> = [
  // primitives
  {
    group: "primitives",
    name: "SimpleString",
    exportName: "validateSimpleString",
    schema: SimpleString,
  },
  {
    group: "primitives",
    name: "StringWithChecks",
    exportName: "validateStringWithChecks",
    schema: StringWithChecks,
  },
  {
    group: "primitives",
    name: "NumberWithChecks",
    exportName: "validateNumberWithChecks",
    schema: NumberWithChecks,
  },
  { group: "primitives", name: "SimpleEnum", exportName: "validateSimpleEnum", schema: SimpleEnum },
  { group: "primitives", name: "BigInt", exportName: "validateBigInt", schema: BigIntSchema },

  // objects
  { group: "objects", name: "User", exportName: "validateUser", schema: UserSchema },
  {
    group: "objects",
    name: "ApiResponse",
    exportName: "validateApiResponse",
    schema: ApiResponseSchema,
  },

  // collections
  { group: "collections", name: "Tuple", exportName: "validateTuple", schema: TupleSchema },
  { group: "collections", name: "Record", exportName: "validateRecord", schema: RecordSchema },
  { group: "collections", name: "Set", exportName: "validateSet", schema: SetSchema },
  { group: "collections", name: "Map", exportName: "validateMap", schema: MapSchema },

  // unions
  {
    group: "unions",
    name: "DiscriminatedUnion",
    exportName: "validateDiscriminatedUnion",
    schema: DiscriminatedUnionSchema,
  },

  // effects
  {
    group: "effects",
    name: "ZeroCaptureTransform",
    exportName: "validateZeroCaptureTransform",
    schema: ZeroCaptureTransformStringSchema,
  },
  {
    group: "effects",
    name: "ZeroCaptureRefine",
    exportName: "validateZeroCaptureRefine",
    schema: ZeroCaptureRefineStringSchema,
  },
  {
    group: "effects",
    name: "CapturedTransform (fallback)",
    exportName: "validateCapturedTransform",
    schema: CapturedTransformSchema,
  },

  // real-world
  { group: "real-world", name: "EventLog", exportName: "validateEventLog", schema: EventLogSchema },
  {
    group: "real-world",
    name: "PartialFallback",
    exportName: "validatePartialFallback",
    schema: PartialFallbackObjectSchema,
  },

  // recursive
  { group: "recursive", name: "TreeNode", exportName: "validateTreeNode", schema: TreeNodeSchema },
];

// --- Formatting ---

const COL_NAME = 36;
const COL_NUM = 10;

const rpad = (s: string, n: number) => s.padEnd(n);
const lpad = (s: string, n: number) => s.padStart(n);
const RULE = `${"─".repeat(COL_NAME)}┼${"─".repeat(COL_NUM)}┼${"─".repeat(COL_NUM)}`;

const print = (s: string) => process.stdout.write(`${s}\n`);
const printErr = (s: string) => process.stderr.write(`${s}\n`);

function printHeader() {
  print(`\nzod-compiler size report  (zodCompat: false, 1 schema per file)\n`);
  print(`${"─".repeat(COL_NAME)}┬${"─".repeat(COL_NUM)}┬${"─".repeat(COL_NUM)}`);
  print(`${rpad("Schema", COL_NAME)}│${lpad("Raw (B)", COL_NUM)}│${lpad("Gzip (B)", COL_NUM)}`);
  print(RULE);
}

function printGroupSeparator(group: string) {
  const label = `  ${group}`;
  print(`${rpad(label, COL_NAME)}│${"─".repeat(COL_NUM)}┼${"─".repeat(COL_NUM)}`);
}

function printRow(name: string, raw: number, gzip: number) {
  print(
    `${rpad(`    ${name}`, COL_NAME)}│${lpad(String(raw), COL_NUM)}│${lpad(String(gzip), COL_NUM)}`,
  );
}

function printFooter(totalRaw: number, totalGzip: number, count: number) {
  print(`${"─".repeat(COL_NAME)}┴${"─".repeat(COL_NUM)}┴${"─".repeat(COL_NUM)}`);
  print(
    `${rpad(`Total (${count} schemas)`, COL_NAME)}  ${lpad(String(totalRaw), COL_NUM - 2)}  ${lpad(String(totalGzip), COL_NUM - 2)}`,
  );
}

// --- Main ---

printHeader();

let lastGroup = "";
let totalRaw = 0;
let totalGzip = 0;
let count = 0;

for (const { group, name, exportName, schema } of SCHEMAS) {
  if (group !== lastGroup) {
    printGroupSeparator(group);
    lastGroup = group;
  }

  try {
    const info = makeInfo(exportName, schema);
    const { raw, gzip } = measure(info);
    totalRaw += raw;
    totalGzip += gzip;
    count++;
    printRow(name, raw, gzip);
  } catch (err) {
    printRow(name, -1, -1);
    printErr(`    [error] ${String(err)}`);
  }
}

printFooter(totalRaw, totalGzip, count);
