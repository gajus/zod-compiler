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
  /**
   * Emit a BARE `invalid_format` issue — no `origin`, no `pattern`.
   *
   * Zod's `invalid_format` shape is not uniform, and the split follows which
   * check instance ends up installed. `$ZodCheckStringFormat.init` installs the
   * DEFAULT pattern check with `inst._zod.check ??= …`, and that default pushes
   * `origin: "string"` plus `pattern: def.pattern.toString()`. A constructor
   * that OVERRIDES `inst._zod.check` afterwards pushes its own issue instead —
   * `$ZodCustomStringFormat` (what `z.stringFormat()`, `z.hex()`, `z.hostname()`
   * and `z.hash()` all build) pushes only `{ code, format, input }`, because it
   * validates through `def.fn` and never consults `def.pattern`.
   *
   * The compiler validates with the pattern either way, so this flag records
   * WHICH issue shape to reproduce. Set from the structural `def.fn` marker in
   * src/core/extract/checks.ts — a format's name is user-chosen, so it cannot be
   * decided from a name list.
   */
  bareIssue?: boolean;
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
  /**
   * fn.toString() result, e.g. "v => v.includes('@')". Set when the predicate
   * is zero-capture and can be inlined into the generated code. Mutually
   * exclusive with {@link refIndex}.
   */
  source?: string;
  /**
   * `__rf[N]` index of the predicate, used when the callback CAPTURES outer
   * variables and so cannot be inlined. The generated code calls the user's
   * original function object through the schema reference instead of
   * delegating the whole schema to zod — a captured `.refine()` on a root
   * object otherwise costs the entire compilation (measured 246.7 ns vs
   * 10.4 ns for the same schema with an inlinable predicate).
   */
  refIndex?: number;
  /** Custom error message from .refine(fn, "message") or .refine(fn, { message }) */
  message?: string;
  /**
   * Issue path suffix from `.refine(fn, { path: [...] })`, appended to the
   * node's own path — zod reports the failure against that member rather than
   * the refined value itself.
   */
  path?: (string | number)[];
  /**
   * `__rf[N]` index of the `params` object from `.refine(fn, { params })`.
   * $ZodCustom copies it onto the issue (`if (def.params) _iss.params =
   * def.params`) BY REFERENCE, so it is held as a reference rather than baked
   * as a literal: the value may be anything (functions, symbols, a cycle), and
   * an error map comparing `issue.params === myParams` — the reason to pass
   * params at all — would fail against a per-failure copy.
   */
  paramsRefIndex?: number;
}

/**
 * A `superRefine` (or a raw `.check(payloadFn)`): a callback that receives zod's
 * PAYLOAD and pushes issues onto it, rather than returning a boolean.
 *
 * Compiled by calling the callback through `__rf[N]` with a synthesized
 * `{ value, issues }` payload — zod's own wrapper installs `addIssue` and
 * normalizes what the user adds, so issue shapes are zod's by construction.
 * Only emitted when the check is LAST on its node: an issue carrying
 * `fatal`/`continue:false` aborts zod's remaining check chain, which compiled
 * output (running every check) could not reproduce.
 */
export interface SuperRefineEffectCheckIR {
  kind: "super_refine_effect";
  /** `__rf[N]` index of the payload-taking callback. */
  refIndex: number;
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
export type CheckOrEffectIR =
  | CheckIR
  | RefineEffectCheckIR
  | SuperRefineEffectCheckIR
  | OverwriteEffectCheckIR;

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

/**
 * A value accepted by `z.literal()`.
 *
 * Zod TYPES the argument as `util.Literal = string | number | bigint | boolean
 * | null | undefined`, but its runtime does `new Set(def.values).has(input)` —
 * so anything at all parses, and a SYMBOL is the off-type value people actually
 * pass (branded keys, well-known registry symbols). `symbol` is therefore
 * admitted here; other reference values (an object, a function) are equally
 * legal at runtime and are handled by the same route, because the codegen guard
 * that splits the two paths ({@link import("./codegen/context.js").hasSourceForm})
 * is a total `typeof` test rather than a list of exclusions.
 */
export type LiteralValue = string | number | boolean | null | bigint | undefined | symbol;

export interface LiteralIR {
  type: "literal";
  values: LiteralValue[];
  /**
   * Index into `__rf[]` — the original `z.literal()` schema — present ONLY when
   * at least one value has no JS source form. Codegen then tests membership
   * against that schema's own `_zod.def.values` at runtime instead of emitting
   * `===` comparisons it cannot spell. See the literal extractor and generator.
   */
  refIndex?: number;
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
  /**
   * Strip unknown keys from the output (zod's DEFAULT `z.object()` behavior),
   * set whenever this is a genuine `z.object()` (no catchall) — never on
   * `z.looseObject()` (keep) or `z.strictObject()` (reject). Compiled by
   * rebuilding a fresh object from
   * only the declared own keys, mirroring zod's strip exactly. Because the
   * output is a fresh value, a strip object counts as a {@link hasMutation}
   * node: it never takes the zero-allocation by-reference fast path, and parent
   * containers clone before it writes back (so intersections of strip objects
   * delegate to zod, matching zod's merge-then-strip semantics). Mutually
   * exclusive with `strict`.
   */
  stripUnknownKeys?: boolean;
  /** Object-level refine effects from z.object({...}).refine(fn) */
  checks?: (RefineEffectCheckIR | SuperRefineEffectCheckIR)[];
  /**
   * `.catchall(schema)`: every key not in the shape is validated against this
   * schema instead of being ignored (plain object) or rejected (strict).
   * Mutually exclusive with `strict` — `.catchall(z.never())` IS strict — and
   * with `stripUnknownKeys`, since a catchall exists to KEEP unknown keys.
   */
  catchall?: SchemaIR;
  /**
   * Keys whose zod schema sits on the middle rung of `optin` ("optional") and is
   * optional-out, and whose compiled property could still raise an issue or
   * produce a value when handed `undefined` (a fallback, a union, a pipe). When
   * the key is ABSENT the property is not run at all — zod's
   * handlePropertyResult returns before looking at the result, so nothing it
   * made of `undefined` is reported or kept. The plain `.optional()` property
   * needs no entry: its compiled form already short-circuits `undefined`.
   */
  skipAbsentKeys?: string[];
  /**
   * Keys whose zod schema is "defaulted" (`.default()`, `.prefault()`, a union
   * containing one) AND optional-out, and whose compiled property could raise
   * an issue for `undefined`: when the key is ABSENT the property runs — the
   * substitute must fire — but a failure is swallowed, issues and value alike
   * (mirrors zod's handlePropertyResult). Lets `z.prefault().optional()` and
   * friends fall back at the property level without rejecting missing keys.
   */
  suppressAbsentKeys?: string[];
  /**
   * Keys whose zod schema is NOT optional-in (`_zod.optin === undefined`) but
   * whose compiled property might accept `undefined` — `z.any()`, `z.unknown()`,
   * `z.undefined()`, a union with such an option. zod runs the property on the
   * absent key's `undefined` and, when that raised nothing, reports
   * `invalid_type` with `expected: "nonoptional"` at the key: a required key
   * has to be PRESENT, whatever its schema thinks of `undefined`. Keys whose
   * property rejects `undefined` outright are omitted — their own issue
   * already stands in for the absence.
   */
  nonoptionalKeys?: string[];
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
  /**
   * zod's `optinStart`, captured from the live schemas at extraction time: the
   * index after the last item whose `_zod.optin` is `undefined`.
   *
   * ```js
   * for (let i = items.length - 1; i >= 0; i--) if (items[i]._zod.optin === undefined) return i + 1;
   * return 0;
   * ```
   *
   * Without a rest element an input shorter than this is rejected outright with
   * a single `too_small` (`minimum: optStart`, `inclusive: true`) before any
   * item runs. `optin` is a three-rung ladder — `undefined` (required),
   * `"optional"` (absence permitted, nothing supplied) and `"defaulted"`
   * (absence permitted, a value substituted) — and any rung above `undefined`
   * lets the slot be absent.
   *
   * Read from `_zod.optin` rather than inferred from the item's IR type because
   * "optional-in" is a property of the ZOD schema, not of the shape the compiler
   * managed to compile: `z.exactOptional()`, `z.prefault()` and pipes extract to
   * an opaque `fallback` leaf, `z.nullable(z.string().optional())` extracts to a
   * node named nothing like "optional", and a union is optional-in when ANY
   * option is.
   */
  optStart: number;
  /**
   * zod's `optoutStart`: the index after the last item whose `_zod.optout` is
   * not `"optional"` — computed like {@link optStart} but over `optout`. Absent
   * only when it equals `items.length` (every slot is required-out).
   *
   * From this index on, an absent slot can END the output: zod's
   * `handleTupleResults` truncates the tail there when the item is on the
   * "optional" rung (see {@link optionalIn}) or when running it on `undefined`
   * failed, and afterwards drops trailing `undefined`s that absent slots
   * produced. Below it an absent slot is materialized as `undefined` (or as
   * whatever the item substituted), because a later required-out slot has to
   * keep its index.
   */
  optoutStart?: number;
  /**
   * Indices whose item sits on the middle rung, `_zod.optin === "optional"`.
   * Absent only when empty. At or past {@link optoutStart} such a slot, when
   * absent, ends the output without running its schema; a "defaulted" slot
   * there runs and keeps what it produced. Below `optoutStart` both run and
   * write their result back.
   */
  optionalIn?: number[];
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
  /**
   * Emit `Object.freeze` on the produced value.
   *
   * Set only when the freeze is OBSERVABLE and the value being frozen is one
   * the compiler allocated (a stripping object, which both the build pass and
   * the eager walk rebuild). Omitted when the inner yields a primitive, where
   * freezing is a no-op and the wrapper compiles to nothing at all.
   *
   * A readonly carrying this flag counts as rebuilding (see rebuildSet), which
   * is what withholds every by-reference shortcut — `fastResultIsInput` turns
   * false, so neither safeParse's `data:input` return nor the `fc` behind
   * `parse()` / `~standard` can hand back an unfrozen input.
   */
  freeze?: boolean;
}

export interface DefaultIR {
  type: "default";
  inner: SchemaIR;
  refIndex: number;
  /**
   * The declared default value is not itself `undefined`, read off the schema at
   * extraction time. That makes the node's output ALWAYS defined — the default
   * branch yields the declared value, and the inner branch only runs for a
   * non-undefined input, which zod's strip test keeps regardless of what the
   * inner produced. Lets a defaulted property claim a slot in the output object
   * literal instead of a conditional append (see outputAlwaysDefined).
   *
   * Absent for the degenerate `.default(undefined)`, where zod drops the key.
   */
  alwaysDefined?: boolean;
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
  /**
   * fn.toString() result, e.g. "v => v.toLowerCase()". Set when the callback is
   * zero-capture and can be inlined. Mutually exclusive with {@link refIndex}.
   */
  source?: string;
  /**
   * `__rf[N]` index of the transform, used when the callback CAPTURES outer
   * variables. Calling the user's own function object keeps the schema compiled;
   * delegating the whole schema to zod instead measured 163.7 ns against zod's
   * own 136.7 ns — the fallback wrapper made it SLOWER than not compiling.
   */
  refIndex?: number;
  /** The input schema to validate before applying the transform */
  inner: SchemaIR;
}

export interface PreprocessEffectIR {
  type: "effect";
  effectKind: "preprocess";
  /** Zero-capture preprocessor source, mutually exclusive with refIndex. */
  source?: string;
  /** Runtime callback reference for a capturing preprocessor. */
  refIndex?: number;
  /** The output schema to validate after applying the preprocessor. */
  inner: SchemaIR;
}

// ─── Schema IR: Special ────────────────────────────────────────────────────

/**
 * z.custom() / z.instanceof(): call the predicate on the hot path and retain
 * the original schema solely for exact, cold-path issue production.
 */
export interface CustomIR {
  type: "custom";
  /** Zero-capture predicate source, mutually exclusive with refIndex. */
  source?: string;
  /** __rf[] index of a captured predicate, mutually exclusive with source. */
  refIndex?: number;
  /** __rf[] index of the pristine Zod schema used by the slow error walk. */
  schemaRefIndex: number;
  /** z.custom() defaults to aborting a failed union option. */
  abort: boolean;
}

/**
 * A schema whose hot-path verdict/output can be compiled through `inner`, but
 * whose cold issue walk delegates to the retained pristine Zod schema. Used
 * when success semantics are simpler than exact failure semantics.
 */
export interface ZodDelegateIR {
  type: "zodDelegate";
  inner: SchemaIR;
  /** __rf[] index of the pristine Zod schema used by the slow error walk. */
  refIndex: number;
}

export interface FallbackIR {
  type: "fallback";
  reason:
    | "transform"
    | "refine"
    | "superRefine"
    | "custom"
    | "lazy"
    | "readonly"
    | "unsupported"
    | "coalesced";
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
    | PreprocessEffectIR
    // Special
    | CustomIR
    | ZodDelegateIR
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
