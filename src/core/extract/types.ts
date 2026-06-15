export interface ZodCheckDef {
  check: string;
  type: string;
  format: string;
  pattern: RegExp | string;
  minimum: number;
  maximum: number;
  length: number;
  size: number;
  value: number;
  inclusive: boolean;
  includes: string;
  position: number;
  prefix: string;
  suffix: string;
  fn: unknown;
  /** $ZodCheckOverwrite transform function (.trim(), .toLowerCase(), ...). */
  tx?: unknown;
  /** Runtime predicate gating check execution — forces fallback when present. */
  when?: unknown;
  /** abort:true stops later checks and marks union options aborted — forces fallback. */
  abort?: boolean;
  mime: string[];
  /** url-only constraints (z.httpUrl()). */
  hostname?: RegExp;
  protocol?: RegExp;
  normalize?: boolean;
  error?: unknown;
}

export interface ZodCheckSchema {
  _zod?: {
    def: ZodCheckDef;
  };
}

export interface ZodDef {
  type: string;
  checks: ZodCheckSchema[];
  check: string;
  format: string;
  pattern: RegExp | string;
  /** Schema-level custom error (z.string({ error: "..." })). */
  error?: unknown;
  /** Unknown-key policy schema (z.strictObject → never, z.looseObject → unknown). */
  catchall?: ZodSchema;
  shape: Record<string, ZodSchema>;
  element: ZodSchema;
  options: ZodSchema[];
  innerType: ZodSchema;
  values: (string | number | boolean | null | bigint | undefined)[];
  entries: Record<string, string>;
  in: ZodSchema;
  out: ZodSchema;
  items: ZodSchema[];
  rest: ZodSchema | null;
  keyType: ZodSchema;
  valueType: ZodSchema;
  left: ZodSchema;
  right: ZodSchema;
  discriminator: string;
  /** false on z.xor() unions (exactly-one-match semantics). */
  inclusive?: boolean;
  defaultValue: unknown;
  coerce?: boolean;
  catchValue?: (ctx: unknown) => unknown;
  /** Transform function reference (present when type is "transform", and on Codec pipes). */
  transform?: unknown;
  /** Reverse transform (present on Codec schemas like stringbool). */
  reverseTransform?: unknown;
}

export interface ZodSchema {
  _zod: {
    def: ZodDef;
    bag?: Record<string, unknown>;
    /** Resolved inner type for lazy schemas. */
    innerType?: ZodSchema;
    /** Pre-compiled pattern for templateLiteral schemas. */
    pattern?: RegExp;
    /** Finite value set (enum/literal keys) — drives exhaustive-key records. */
    values?: Set<unknown>;
    /** Class trait names from zod's $constructor (e.g. "$ZodExactOptional"). */
    traits?: Set<string>;
    /** "optional" when the key may be absent in object output (zod optout). */
    optout?: string;
    /** Discriminator dispatch values per property key (discriminated unions). */
    propValues?: Record<string, Set<unknown> | undefined>;
  };
}

/** Entry collected during extraction for each fallback sub-schema. */
export interface RefEntry {
  /** Runtime reference to the Zod sub-schema. */
  schema: unknown;
  /** Navigation path from root schema, e.g. '.shape["slug"]' */
  accessPath: string;
}

// ─── Supported Zod def.type values ──────────────────────────────────────────

/** All Zod v4 def.type values that zod-compiler supports. */
export type SupportedZodDefType =
  | "boolean"
  | "null"
  | "undefined"
  | "any"
  | "unknown"
  | "symbol"
  | "void"
  | "nan"
  | "never"
  | "literal"
  | "enum"
  | "optional"
  | "nullable"
  | "readonly"
  | "intersection"
  | "string"
  | "number"
  | "bigint"
  | "date"
  | "object"
  | "array"
  | "tuple"
  | "record"
  | "set"
  | "map"
  | "union"
  | "default"
  | "pipe"
  | "lazy"
  | "catch"
  | "template_literal"
  | "file";

// ─── Recursion state ──────────────────────────────────────────────────────

/**
 * Shared, mutable recursion-target bookkeeping for one {@link extractSchema}
 * call. Lazy cycle detection assigns each NON-root recursion target a stable
 * refId (≥ 1) keyed by Zod schema identity; the root schema is identified
 * separately and uses the implicit refId 0. `dispatch` wraps a schema's IR in
 * a `recursionTarget` node when that schema turns out to be a non-root target.
 */
export interface RecursionState {
  /** The root schema of this extraction (first dispatched), for root detection. */
  readonly root: unknown;
  /** Non-root recursion targets: Zod schema → assigned refId (≥ 1). */
  readonly targets: Map<unknown, number>;
  /** Next refId to hand out (starts at 1; 0 is reserved for the root). */
  next: number;
}

// ─── Extractor context ──────────────────────────────────────────────────────

/** Context object for extractor functions. Unifies the varied parameter patterns. */
export interface ExtractorContext {
  /** Raw Zod schema reference (for fallback entries and schema._zod access). */
  readonly schema: unknown;
  /** Navigation path from root, e.g. '._zod.def.innerType' */
  readonly path: string;
  /** Fallback entries collector (undefined if partial fallback disabled). */
  readonly refs: RefEntry[] | undefined;
  /** Cycle detection set for lazy resolution. */
  readonly visiting: Set<unknown>;
  /** Recursion-target bookkeeping (shared across the whole extraction). */
  readonly recursion: RecursionState;

  /** Recursively extract a child schema. Manages visiting set automatically. */
  visit(childSchema: unknown, pathSuffix?: string): import("../types.js").SchemaIR;

  /** Create a fallback entry for non-compilable sub-schemas. */
  fallback(reason: import("../types.js").FallbackIR["reason"]): import("../types.js").FallbackIR;
}

/** Extractor function signature — registered in extractRegistry. */
export type Extractor = (def: ZodDef, ctx: ExtractorContext) => import("../types.js").SchemaIR;
