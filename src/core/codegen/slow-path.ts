import type { SchemaIR } from "../types.js";
import type { CodeGenContext, SlowGen, SlowGenerator } from "./context.js";
import { emitRegex, emitSet, emitTemp } from "./context.js";
import { slowAny } from "./schemas/any.js";
import { slowArray } from "./schemas/array.js";
import { slowBigInt } from "./schemas/bigint.js";
import { slowBoolean } from "./schemas/boolean.js";
import { slowCatch } from "./schemas/catch.js";
import { slowDate } from "./schemas/date.js";
import { slowDefault } from "./schemas/default.js";
import { slowDiscriminatedUnion } from "./schemas/discriminated-union.js";
import { slowEffect } from "./schemas/effect.js";
import { slowEnum } from "./schemas/enum.js";
import { slowFallback } from "./schemas/fallback.js";
import { slowFile } from "./schemas/file.js";
import { slowIntersection } from "./schemas/intersection.js";
import { slowLiteral } from "./schemas/literal.js";
import { slowMap } from "./schemas/map.js";
import { slowNan } from "./schemas/nan.js";
import { slowNever } from "./schemas/never.js";
import { slowNull } from "./schemas/null.js";
import { slowNullable } from "./schemas/nullable.js";
import { slowNumber } from "./schemas/number.js";
import { slowObject } from "./schemas/object.js";
import { slowOptional } from "./schemas/optional.js";
import { slowPipe } from "./schemas/pipe.js";
import { slowReadonly } from "./schemas/readonly.js";
import { slowRecord } from "./schemas/record.js";
import { slowRecursiveRef } from "./schemas/recursive-ref.js";
import { slowSet } from "./schemas/set.js";
import { slowString } from "./schemas/string.js";
import { slowStringBool } from "./schemas/string-bool.js";
import { slowSymbol } from "./schemas/symbol.js";
import { slowTemplateLiteral } from "./schemas/template-literal.js";
import { slowTuple } from "./schemas/tuple.js";
import { slowUndefined } from "./schemas/undefined.js";
import { slowUnion } from "./schemas/union.js";
import { slowUnknown } from "./schemas/unknown.js";
import { slowVoid } from "./schemas/void.js";

// ─── Typed registry ─────────────────────────────────────────────────────────
// Adding a new SchemaIR type without registering a generator here causes a
// compile error, preventing the silent-missing-case bugs that plagued the old
// switch-based dispatch.

const slowRegistry = {
  // Primitives (order follows SchemaIR union in types.ts)
  string: slowString,
  number: slowNumber,
  boolean: slowBoolean,
  bigint: slowBigInt,
  date: slowDate,
  symbol: slowSymbol,
  null: slowNull,
  undefined: slowUndefined,
  void: slowVoid,
  nan: slowNan,
  never: slowNever,
  any: slowAny,
  unknown: slowUnknown,
  literal: slowLiteral,
  enum: slowEnum,
  // Containers
  object: slowObject,
  array: slowArray,
  tuple: slowTuple,
  record: slowRecord,
  set: slowSet,
  map: slowMap,
  file: slowFile,
  // Unions & Intersections
  union: slowUnion,
  discriminatedUnion: slowDiscriminatedUnion,
  intersection: slowIntersection,
  // Modifiers
  optional: slowOptional,
  nullable: slowNullable,
  readonly: slowReadonly,
  default: slowDefault,
  pipe: slowPipe,
  // Effects
  effect: slowEffect,
  // Special
  templateLiteral: slowTemplateLiteral,
  catch: slowCatch,
  fallback: slowFallback,
  recursiveRef: slowRecursiveRef,
  stringBool: slowStringBool,
} satisfies {
  [K in SchemaIR["type"]]: SlowGenerator<Extract<SchemaIR, { type: K }>>;
};

// ─── Factory ─────────────────────────────────────────────────────────────────
// Lives here (not in context.ts) to avoid circular imports:
// visit() → generateSlow() → imports from context.ts

export function createSlowGen(
  inputExpr: string,
  outputExpr: string,
  pathExpr: string,
  issuesVar: string,
  ctx: CodeGenContext,
): SlowGen {
  return {
    input: inputExpr,
    output: outputExpr,
    path: pathExpr,
    issues: issuesVar,
    ctx,
    visit(ir, overrides) {
      return generateSlow(
        ir,
        createSlowGen(
          overrides?.input ?? inputExpr,
          overrides?.output ?? outputExpr,
          overrides?.path ?? pathExpr,
          overrides?.issues ?? issuesVar,
          ctx,
        ),
      );
    },
    temp: (prefix) => emitTemp(ctx, prefix),
    regex: (prefix, pattern, flags) => emitRegex(ctx, prefix, pattern, flags),
    set: (prefix, values) => emitSet(ctx, prefix, values),
  };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export function generateSlow(ir: SchemaIR, g: SlowGen): string {
  // Surface the node's schema-level error message to issue emission. visit()
  // always builds a fresh context, so typeMsg never leaks into child nodes.
  const gen0 = ir.typeMessage !== g.typeMsg ? { ...g, typeMsg: ir.typeMessage } : g;
  const gen = slowRegistry[ir.type];
  // oxlint-disable-next-line typescript/no-explicit-any -- registry dispatch requires type erasure at call site
  return (gen as any)(ir, gen0);
}
