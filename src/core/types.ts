/**
 * SchemaIR — Intermediate representation for Zod schemas.
 * Extracted from Zod's `_zod.def` and `_zod.bag` at build time.
 */

// ─── Check IR ───────────────────────────────────────────────────────────────

/** Shared base: static custom error message extracted from the check's `error` param. */
export interface CheckBase {
  /** Static message from e.g. `.min(3, "too short")`. Dynamic error maps force fallback. */
  message?: string;
}

export interface CheckMinLength extends CheckBase {
  kind: "min_length";
  minimum: number;
}

export interface CheckMaxLength extends CheckBase {
  kind: "max_length";
  maximum: number;
}

export interface CheckLengthEquals extends CheckBase {
  kind: "length_equals";
  length: number;
}

export interface CheckGreaterThan extends CheckBase {
  kind: "greater_than";
  value: number;
  inclusive: boolean;
}

export interface CheckLessThan extends CheckBase {
  kind: "less_than";
  value: number;
  inclusive: boolean;
}

export interface CheckMultipleOf extends CheckBase {
  kind: "multiple_of";
  value: number;
}

export interface CheckNumberFormat extends CheckBase {
  kind: "number_format";
  format: "safeint" | "int32" | "uint32" | "float32" | "float64";
}

export interface CheckStringFormat extends CheckBase {
  kind: "string_format";
  format: string;
  pattern?: string;
  /** RegExp flags of the source pattern (e.g. "u" for z.emoji()). */
  patternFlags?: string;
  /** url-only: hostname constraint regex source (z.httpUrl()). */
  hostname?: string;
  hostnameFlags?: string;
  /** url-only: protocol constraint regex source (z.httpUrl()). */
  protocol?: string;
  protocolFlags?: string;
  /** url-only: output url.href instead of the trimmed input. */
  normalize?: boolean;
}

export interface CheckIncludes extends CheckBase {
  kind: "includes";
  includes: string;
  position?: number;
}

export interface CheckStartsWith extends CheckBase {
  kind: "starts_with";
  prefix: string;
}

export interface CheckEndsWith extends CheckBase {
  kind: "ends_with";
  suffix: string;
}

export type CheckIR =
  | CheckMinLength
  | CheckMaxLength
  | CheckLengthEquals
  | CheckGreaterThan
  | CheckLessThan
  | CheckMultipleOf
  | CheckNumberFormat
  | CheckStringFormat
  | CheckIncludes
  | CheckStartsWith
  | CheckEndsWith;

// ─── Refine Effect Check IR ────────────────────────────────────────────────
// Inline refine effects compiled via fn.toString(). Inserted into checks[]
// arrays preserving original Zod check ordering.

export interface RefineEffectCheckIR {
  kind: "refine_effect";
  /** fn.toString() result, e.g. "v => v.includes('@')" */
  source: string;
  /** Custom error message from .refine(fn, "message") or .refine(fn, { message }) */
  message?: string;
}

/**
 * Value-rewriting check compiled from a $ZodCheckOverwrite (.trim(), .toLowerCase(), ...).
 * Applied at its original position: `value = (source)(value)`. Never produces issues.
 */
export interface OverwriteEffectCheckIR {
  kind: "overwrite_effect";
  /** fn.toString() of the overwrite transform, e.g. "(input) => input.trim()" */
  source: string;
}

/** A check entry that may be a compiled check or an inline effect. */
export type CheckOrEffectIR = CheckIR | RefineEffectCheckIR | OverwriteEffectCheckIR;

// ─── Date Check IR ──────────────────────────────────────────────────────────

export interface CheckDateGreaterThan extends CheckBase {
  kind: "date_greater_than";
  value: string;
  timestamp: number;
  inclusive: boolean;
}

export interface CheckDateLessThan extends CheckBase {
  kind: "date_less_than";
  value: string;
  timestamp: number;
  inclusive: boolean;
}

export type DateCheckIR = CheckDateGreaterThan | CheckDateLessThan;

// ─── BigInt Check IR ───────────────────────────────────────────────────────

export interface CheckBigIntGreaterThan extends CheckBase {
  kind: "bigint_greater_than";
  /** String representation of the BigInt value (e.g. "10") */
  value: string;
  inclusive: boolean;
}

export interface CheckBigIntLessThan extends CheckBase {
  kind: "bigint_less_than";
  /** String representation of the BigInt value (e.g. "100") */
  value: string;
  inclusive: boolean;
}

export interface CheckBigIntMultipleOf extends CheckBase {
  kind: "bigint_multiple_of";
  /** String representation of the BigInt value (e.g. "3") */
  value: string;
}

export type BigIntCheckIR = CheckBigIntGreaterThan | CheckBigIntLessThan | CheckBigIntMultipleOf;

// ─── Set Check IR ──────────────────────────────────────────────────────────

export interface CheckMinSize extends CheckBase {
  kind: "min_size";
  minimum: number;
}

export interface CheckMaxSize extends CheckBase {
  kind: "max_size";
  maximum: number;
}

export interface CheckSizeEquals extends CheckBase {
  kind: "size_equals";
  size: number;
}

export type SetCheckIR = CheckMinSize | CheckMaxSize | CheckSizeEquals;

// ─── File Check IR ────────────────────────────────────────────────────────

export interface CheckMimeType extends CheckBase {
  kind: "mime_type";
  mime: string[];
}

export type FileCheckIR = CheckMinSize | CheckMaxSize | CheckMimeType;

// ─── Schema IR: Primitives ─────────────────────────────────────────────────

export interface StringIR {
  type: "string";
  checks: CheckOrEffectIR[];
  coerce?: boolean;
}

export interface NumberIR {
  type: "number";
  checks: CheckOrEffectIR[];
  coerce?: boolean;
}

export interface BooleanIR {
  type: "boolean";
  coerce?: boolean;
}

export interface BigIntIR {
  type: "bigint";
  checks: BigIntCheckIR[];
  coerce?: boolean;
}

export interface DateIR {
  type: "date";
  checks: DateCheckIR[];
  coerce?: boolean;
}

export interface SymbolIR {
  type: "symbol";
}

export interface NullIR {
  type: "null";
}

export interface UndefinedIR {
  type: "undefined";
}

export interface VoidIR {
  type: "void";
}

export interface NanIR {
  type: "nan";
}

export interface NeverIR {
  type: "never";
}

export interface AnyIR {
  type: "any";
}

export interface UnknownIR {
  type: "unknown";
}

export interface LiteralIR {
  type: "literal";
  values: (string | number | boolean | null | bigint | undefined)[];
}

export interface EnumIR {
  type: "enum";
  /** Accepted values — z.nativeEnum() can contribute numbers. */
  values: (string | number)[];
}

// ─── Schema IR: Containers ─────────────────────────────────────────────────

export interface ObjectIR {
  type: "object";
  properties: Record<string, SchemaIR>;
  /**
   * Reject unknown keys (z.strictObject / .strict() / .catchall(z.never())).
   * Compiled as a for-in membership pass after the property checks, mirroring
   * zod's handleCatchall exactly: `for (const key in input)` (inherited
   * enumerable keys count, no hasOwnProperty filter) collecting ALL unknown
   * keys into ONE `unrecognized_keys` issue pushed after property issues.
   * Pass-through still holds — valid strict data has no extra keys, so
   * data === input and the schema stays Fast Path eligible.
   */
  strict?: boolean;
  /** Object-level refine effects from z.object({...}).refine(fn) */
  checks?: RefineEffectCheckIR[];
  /**
   * Fallback-typed property keys whose zod schema is optional-out: when the
   * key is ABSENT from the input, their issues are suppressed (mirrors zod's
   * handlePropertyResult). Lets z.exactOptional() and friends fall back at
   * the property level without rejecting missing keys.
   */
  suppressAbsentKeys?: string[];
}

export interface ArrayIR {
  type: "array";
  element: SchemaIR;
  checks: CheckOrEffectIR[];
}

export interface TupleIR {
  type: "tuple";
  items: SchemaIR[];
  rest: SchemaIR | null;
}

export interface RecordIR {
  type: "record";
  keyType: SchemaIR;
  valueType: SchemaIR;
}

export interface SetIR {
  type: "set";
  valueType: SchemaIR;
  checks?: SetCheckIR[];
}

export interface MapIR {
  type: "map";
  keyType: SchemaIR;
  valueType: SchemaIR;
}

export interface FileIR {
  type: "file";
  checks?: FileCheckIR[];
}

// ─── Schema IR: Unions & Intersections ─────────────────────────────────────

export interface UnionIR {
  type: "union";
  options: SchemaIR[];
}

export interface DiscriminatedUnionIR {
  type: "discriminatedUnion";
  discriminator: string;
  options: SchemaIR[];
  /**
   * Typed discriminator-value dispatch table, sourced from zod's
   * `_zod.propValues` (covers literal AND enum discriminators, preserving
   * value types so numeric/boolean discriminators switch correctly).
   */
  cases: { value: string | number | boolean | null | bigint | undefined; option: number }[];
}

export interface IntersectionIR {
  type: "intersection";
  left: SchemaIR;
  right: SchemaIR;
}

// ─── Schema IR: Modifiers ──────────────────────────────────────────────────

export interface OptionalIR {
  type: "optional";
  inner: SchemaIR;
}

export interface NullableIR {
  type: "nullable";
  inner: SchemaIR;
}

export interface ReadonlyIR {
  type: "readonly";
  inner: SchemaIR;
}

export interface DefaultIR {
  type: "default";
  inner: SchemaIR;
  refIndex: number;
}

export interface PipeIR {
  type: "pipe";
  in: SchemaIR;
  out: SchemaIR;
}

// ─── Schema IR: Effects ───────────────────────────────────────────────────

export interface TransformEffectIR {
  type: "effect";
  effectKind: "transform";
  /** fn.toString() result, e.g. "v => v.toLowerCase()" */
  source: string;
  /** The input schema to validate before applying the transform */
  inner: SchemaIR;
}

// ─── Schema IR: Special ────────────────────────────────────────────────────

export interface FallbackIR {
  type: "fallback";
  reason: "transform" | "refine" | "superRefine" | "custom" | "lazy" | "unsupported" | "coalesced";
  /** Index into the __rf[] fallback schemas array. Present when partial fallback is used. */
  refIndex?: number;
}

export interface TemplateLiteralIR {
  type: "templateLiteral";
  pattern: string;
}

export interface CatchIR {
  type: "catch";
  inner: SchemaIR;
  /** Index into __rf[] — the original z.catch() schema whose catchValue runs per parse. */
  refIndex: number;
}

export interface RecursiveRefIR {
  type: "recursiveRef";
  /**
   * Identifies which recursion target this back-edge re-invokes. Absent (or 0)
   * means the ROOT schema — the directly self-recursive case, whose validator
   * is the schema's own `safeParse_<name>` / hosted fast-check. A value ≥ 1
   * targets a non-root sub-schema hosted as a standalone validator (see
   * {@link RecursionTargetIR}); used for recursive schemas nested inside a
   * larger root, multiple distinct recursive sub-schemas, and mutual recursion.
   */
  refId?: number;
}

/**
 * Marks a sub-schema that is the target of one or more {@link RecursiveRefIR}
 * back-edges (refId ≥ 1) — a recursive schema that is NOT the compiled root.
 * Codegen hosts `inner` as a standalone fast-check + safeParse-shaped slow
 * validator so the recursive cycle can call it by name, instead of re-invoking
 * the (wrong-shaped) root validator. The root target needs no wrapper: it IS
 * the root function, so it is never wrapped and uses the implicit refId 0.
 */
export interface RecursionTargetIR {
  type: "recursionTarget";
  refId: number;
  inner: SchemaIR;
}

export interface StringBoolIR {
  type: "stringBool";
  truthy: string[];
  falsy: string[];
  caseSensitive: boolean;
}

// ─── Schema IR Union ───────────────────────────────────────────────────────

/**
 * Optional schema-level static error message (z.string({ error: "..." })).
 * Attached centrally by extract dispatch; consumed by issue emission as the
 * default message for issues created by this node (zod precedence: check
 * error > schema error > locale default). Dynamic schema-level error maps
 * force fallback instead.
 */
export interface TypeMessageCarrier {
  typeMessage?: string;
}

export type SchemaIR = TypeMessageCarrier &
  // Primitives
  (
    | StringIR
    | NumberIR
    | BooleanIR
    | BigIntIR
    | DateIR
    | SymbolIR
    | NullIR
    | UndefinedIR
    | VoidIR
    | NanIR
    | NeverIR
    | AnyIR
    | UnknownIR
    | LiteralIR
    | EnumIR
    // Containers
    | ObjectIR
    | ArrayIR
    | TupleIR
    | RecordIR
    | SetIR
    | MapIR
    | FileIR
    // Unions & Intersections
    | UnionIR
    | DiscriminatedUnionIR
    | IntersectionIR
    // Modifiers
    | OptionalIR
    | NullableIR
    | ReadonlyIR
    | DefaultIR
    | PipeIR
    // Effects
    | TransformEffectIR
    // Special
    | TemplateLiteralIR
    | CatchIR
    | FallbackIR
    | RecursiveRefIR
    | RecursionTargetIR
    | StringBoolIR
  );

// ─── Compiled Schema Interface ──────────────────────────────────────────────

export interface SafeParseSuccess<T> {
  success: true;
  data: T;
}

export interface SafeParseError {
  success: false;
  error: ZodErrorLike;
}

export type SafeParseResult<T> = SafeParseSuccess<T> | SafeParseError;

export interface ZodIssueLike {
  code: string;
  path: (string | number)[];
  message: string;

  [key: string]: unknown;
}

export interface ZodErrorLike {
  issues: ZodIssueLike[];
}

export interface DiscoveredSchema {
  exportName: string;
  schema: unknown;
}

export interface CompiledSchema<T> {
  parse(input: unknown): T;
  parseAsync(input: unknown): Promise<T>;
  safeParse(input: unknown): SafeParseResult<T>;
  safeParseAsync(input: unknown): Promise<SafeParseResult<T>>;
  /**
   * Zero-allocation boolean type guard. For schemas with a total Fast Path
   * (the common case — objects, primitives, arrays, enums without
   * coerce/default/catch/transform), this IS the compiled fast-check function:
   * one boolean expression, no result object, no issues array — the cheapest
   * possible "does this match?" check, on par with typia's `is<T>()`. Schemas
   * without a total Fast Path fall back to `safeParse(input).success`
   * (correct, still allocation-light). Narrows `input` to `T` on `true`.
   */
  is(input: unknown): input is T;
}
