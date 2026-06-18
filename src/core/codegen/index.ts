import type { SchemaIR } from "../types.js";
import type { CodeGenContext, CodeGenResult, CodegenMode, RecTargetGen } from "./context.js";
import { emitRfDelegate, hasMutation } from "./context.js";
import type { SharedSchemaPlan } from "./dedupe.js";
import { createFastGen, generateFast } from "./fast-path.js";
import { createSlowGen, generateSlow } from "./slow-path.js";

export type { CodeGenResult } from "./context.js";

export interface GenerateValidatorOptions {
  refCount?: number;
  /** Codegen output mode. Defaults to "inline". */
  mode?: CodegenMode;
  /**
   * File-level shared slow-walk plan (schema deduplication). Applied only to
   * mutation-free schemas, so shared walks stay on the deferred cold path.
   */
  sharedSchemas?: SharedSchemaPlan | undefined;
  /**
   * Compact mode (`output: "compact"`). Drop the compiled slow walk for
   * mutation-free schemas with a TOTAL fast path and delegate the cold error
   * path to the retained Zod schema (`__zcFinZ`). The fast (hot) path is
   * unchanged; only the bulky error-collecting walk — 64–77% of generated
   * bytes — is replaced by a few bytes of zod delegation. See
   * {@link CodeGenResult.rootDelegateRefIndex}.
   */
  compact?: boolean | undefined;
}

/**
 * Generate optimized validation code from SchemaIR.
 *
 * - `code`: preamble declarations (Sets, RegExps, etc.) — deterministic for the same IR
 * - `functionDef`: full function expression string referencing preamble vars via closure
 * - `usedHelpers`: helper names from "virtual:zod-compiler/runtime" referenced (lean mode only)
 *
 * Usage: `new Function(code + "\nreturn " + functionDef + ";")()`
 */
export function generateValidator(
  ir: SchemaIR,
  name: string,
  options?: GenerateValidatorOptions,
): CodeGenResult {
  const fnName = `safeParse_${name}`;
  const mode: CodegenMode = options?.mode ?? "inline";
  const ctx: CodeGenContext = {
    preamble: [],
    counter: 0,
    fnName,
    regexCache: new Map(),
    mode,
    usedHelpers: new Set(),
  };

  // Enable slow-walk sharing only for mutation-free schemas: their walk is
  // reached solely through __zcFinD (the deferred, cold error path), so every
  // shared call runs only when `.error` is read — never on a successful parse.
  if (options?.sharedSchemas !== undefined && !hasMutation(ir)) {
    ctx.sharedSchemas = options.sharedSchemas;
  }

  // Root-level fallback: the whole schema delegates to Zod, so zod's own
  // safeParse result IS the result. Returning it directly skips the issue
  // copy loop (which would force zod's eager ZodError construction), the
  // pointless [].concat(path) rewrites, and the __zcFin re-wrap. Delegation
  // goes through the pre-mutation capture (emitRfDelegate) — here __rf[0]
  // and the __zcMkv target are routinely the SAME object.
  if (ir.type === "fallback" && ir.refIndex !== undefined) {
    const delegate = emitRfDelegate(ctx, ir.refIndex);
    return {
      code: ["/* zod-compiler */", ...ctx.preamble].join("\n"),
      functionDef: `function ${fnName}(input){return ${delegate}(input);}`,
      refCount: options?.refCount ?? 0,
      usedHelpers: ctx.usedHelpers,
      fastFnName: null,
      fastTotal: false,
    };
  }

  // Recursion-target table. The root (refId 0) reuses the schema's own
  // `safeParse_<name>` / hosted fast-check, so it needs no separate helper and
  // its fast name is allocated lazily during the walk (recFastName). Non-root
  // targets — recursive sub-schemas nested in a larger root, multiple distinct
  // recursive shapes, mutual recursion — are each hosted as a standalone
  // `__rsp_N` (slow) / `__fcr_N` (fast) validator the cycle calls by name.
  // Common directly-self-recursive schemas have no non-root targets, so this
  // leaves their generated output byte-identical.
  const nonRootTargets = collectRecursionTargets(ir);
  ctx.recTargets = new Map<number, RecTargetGen>([[0, { isRoot: true, slowName: fnName }]]);
  for (const [refId, inner] of nonRootTargets) {
    ctx.recTargets.set(refId, {
      isRoot: false,
      inner,
      slowName: `__rsp_${ctx.counter++}`,
      fastName: `__fcr_${ctx.counter++}`,
    });
  }
  const hasNonRootTargets = nonRootTargets.size > 0;

  // Fast Path: generate a boolean expression for eligible schemas.
  //
  // generateFast mutates ctx as it walks (extracted __fo_ helpers + regex/effect
  // decls pushed to the preamble, a recursive __fcr_ name reserved, dedup caches
  // populated). The walk is all-or-nothing: a later fast-ineligible node makes it
  // return null AFTER those side effects already landed. Without a rollback the
  // discarded fast path leaves dead __fo_ helpers in the output — and, when one
  // referenced the recursive __fcr_ host that the `fastExpr !== null` branch below
  // never emits, a dangling reference to an undefined identifier. Snapshot the
  // mutable state and restore it on abort so the slow path re-declares from clean.
  const fastPreambleLen = ctx.preamble.length;
  const fastRegexCache = new Map(ctx.regexCache);
  const fastEffectCache = ctx.effectFnCache && new Map(ctx.effectFnCache);
  const fastRecName = ctx.recFastName;
  const fg = createFastGen("input", ctx);
  let fastExpr = generateFast(ir, fg);
  if (fastExpr !== null && hasNonRootTargets) {
    // Host each non-root recursion target as a boolean fast-check helper. A
    // single fast-ineligible target (e.g. one whose recursive shape contains a
    // fallback) disables the WHOLE fast path: the root expression already emits
    // calls to these names, so a missing body would dangle. The shared
    // rollback below then restores clean state for the slow-only path.
    for (const t of ctx.recTargets.values()) {
      if (t.isRoot) continue;
      const body = generateFast(t.inner as SchemaIR, createFastGen("input", ctx, false));
      if (body === null) {
        fastExpr = null;
        break;
      }
      ctx.preamble.push(`function ${t.fastName}(input){return ${body};}`);
    }
  }
  if (fastExpr === null) {
    ctx.preamble.length = fastPreambleLen;
    ctx.regexCache = fastRegexCache;
    if (fastEffectCache === undefined) delete ctx.effectFnCache;
    else ctx.effectFnCache = fastEffectCache;
    if (fastRecName === undefined) delete ctx.recFastName;
    else ctx.recFastName = fastRecName;
  }

  // Host the fast expression in a named boolean helper. Self-recursive
  // schemas need it so recursive refs can call it; every other eligible
  // schema benefits too: __zcMkv wires it into parse()/parseAsync(), whose
  // success paths then return the input directly — no intermediate
  // SafeParseResult allocation (the safeParse function body is far past
  // V8's inlining budget, so escape analysis never removes it).
  let fastFnName: string | null = null;
  if (fastExpr !== null && fastExpr !== "true") {
    fastFnName = ctx.recFastName ?? `__fc_${ctx.counter++}`;
    ctx.preamble.push(`function ${fastFnName}(input){return ${fastExpr};}`);
    fastExpr = `${fastFnName}(input)`;
  }

  const baseRefCount = options?.refCount ?? 0;

  // Compact mode: a mutation-free schema with a TOTAL fast path needs no
  // compiled slow walk — its only purpose is reproducing zod's issues on
  // failure, and the original zod schema (retained in `output: "compact"`) does
  // that exactly. Emit the fast check and, on failure, delegate to a fresh root
  // RefEntry (the schema itself) via the pristine-bound safeParse capture, then
  // wrap it in the lazy `__zcFinZ` failure. Drops 64–77% of generated bytes
  // with zero hot-path cost (fc and `.is()` are unchanged) and zod-identical
  // errors. Excluded: schemas with non-root recursion targets (mutual/nested
  // recursion still hosts standalone slow validators) and any non-total fast
  // path (mutation/default/catch/fallback) — those keep the compiled path.
  if (
    options?.compact === true &&
    fastExpr !== null &&
    fastExpr !== "true" &&
    !hasMutation(ir) &&
    !hasNonRootTargets
  ) {
    const delegate = emitRfDelegate(ctx, baseRefCount);
    ctx.usedHelpers.add("__zcFinZ");
    return {
      code: ["/* zod-compiler */", ...ctx.preamble].join("\n"),
      functionDef: [
        `function ${fnName}(input){`,
        `if(${fastExpr}){return{success:true,data:input};}`,
        `return __zcFinZ(${delegate},input);`,
        `}`,
      ].join("\n"),
      refCount: baseRefCount + 1,
      usedHelpers: ctx.usedHelpers,
      fastFnName,
      // Mutation-free total fast path: fc(input) ⟺ accepts(input), so `.is()`
      // installs fc directly (compact never weakens the guard).
      fastTotal: true,
      rootDelegateRefIndex: baseRefCount,
    };
  }

  // Host each non-root recursion target as a safeParse-shaped slow validator,
  // mirroring the root's eager body: collect issues, return success+data or a
  // deferred-error result. Always emitted (the slow path always exists); the
  // recursion call sites read `.success` / `.error.issues` / `.data`. Hoisted
  // function declarations, so their order relative to the root is irrelevant.
  if (hasNonRootTargets) {
    for (const t of ctx.recTargets.values()) {
      if (t.isRoot) continue;
      const body = generateSlow(t.inner as SchemaIR, createSlowGen("_d", "_d", "[]", "_e", ctx));
      ctx.usedHelpers.add("__zcFin");
      ctx.preamble.push(
        `function ${t.slowName}(input){var _e=[];\nvar _d=input;\n${body}\n` +
          `if(_e.length===0){return{success:true,data:_d};}\nreturn __zcFin(_e,_d);}`,
      );
    }
  }

  const sg = createSlowGen("_d", "_d", "[]", "_e", ctx);
  // When the root schema's own shape is shared (it recurs as a sub-schema of
  // another export, or as a duplicate root), its slow walk delegates to the
  // shared function instead of emitting a second full copy. The fast path is
  // still generated inline above — only the cold walk is shared.
  const rootRef = ctx.sharedSchemas?.refFor(ir);
  const slowCode = rootRef !== undefined ? `${rootRef.name}(_d,[],_e);` : generateSlow(ir, sg);

  const buildCode = (): string => ["/* zod-compiler */", ...ctx.preamble].join("\n");

  const functionDefParts = [`function ${fnName}(input){`];

  if (fastExpr === "true") {
    // Schema always succeeds (any/unknown) — skip slow path entirely
    functionDefParts.push(`return{success:true,data:input};`);
    functionDefParts.push(`}`);
    return {
      code: buildCode(),
      functionDef: functionDefParts.join("\n"),
      refCount: options?.refCount ?? 0,
      usedHelpers: ctx.usedHelpers,
      fastFnName: null,
      // any/unknown always succeed; `.is()` derives `true` from the fn fallback.
      fastTotal: false,
    };
  }

  if (fastExpr !== null && !hasMutation(ir)) {
    // Mutation-free schemas with a fast path: a fast-check failure can never
    // become a slow-path success (both are generated from the same checks —
    // unlike default/catch/coerce schemas, whose partial fast path requires
    // value presence while the slow path SUCCEEDS by applying the default).
    // The slow path's only output is therefore the issues array, observable
    // solely through `.error` — defer the whole re-walk into the cached
    // accessor (__zcFinD): a failed safeParse whose `.error` is never read
    // costs the fast check alone.
    //
    // The walk is HOSTED as a named preamble function rather than a per-call
    // closure, for two measured reasons: (1) a failed safeParse no longer
    // allocates a closure environment + function object before the deferral
    // even starts; (2) the safeParse body shrinks to two statements, putting
    // it within V8's inlining budget — callers in hot loops get the
    // success-path result object escape-analyzed away entirely, which the
    // old shape (slow walk inlined into the body) made impossible.
    ctx.usedHelpers.add("__zcFinD");
    if (slowCode.includes(fnName)) {
      // Self-recursive slow paths call the safeParse function by NAME
      // (slowRecursiveRef) — that binding exists only inside the named
      // function expression under the documented evaluation contract
      // (`new Function(code + "return " + functionDef)`), so the walk stays
      // a per-call closure for recursive schemas. Recursion is the rare
      // shape; everything else gets the hosted walk.
      functionDefParts.push(
        `if(${fastExpr}){return{success:true,data:input};}`,
        `return __zcFinD(function(input){`,
        `var _e=[];`,
        `var _d=input;`,
        slowCode,
        `return _e;`,
        `},input);`,
        `}`,
      );
    } else {
      const walkName = `__sw_${ctx.counter++}`;
      ctx.preamble.push(
        `function ${walkName}(input){var _e=[];\nvar _d=input;\n${slowCode}\nreturn _e;}`,
      );
      functionDefParts.push(
        `if(${fastExpr}){return{success:true,data:input};}`,
        `return __zcFinD(${walkName},input);`,
        `}`,
      );
    }
    return {
      code: buildCode(),
      functionDef: functionDefParts.join("\n"),
      refCount: options?.refCount ?? 0,
      usedHelpers: ctx.usedHelpers,
      fastFnName,
      // Total predicate: mutation-free fast path, fc(input) ⟺ accepts(input).
      // generateIIFE installs fc directly as the zero-allocation `.is()`.
      fastTotal: true,
    };
  }

  if (fastExpr !== null) {
    // Partial fast path (default/catch/... present-value shortcut): the slow
    // path must run eagerly — it can succeed where the fast check failed.
    functionDefParts.push(`if(${fastExpr}){return{success:true,data:input};}`);
  }

  // Success branch inlined at the call site instead of inside __zcFin: the
  // eager path (mutation schemas — coerce/default/trim/transform) returns
  // here on EVERY parse, and the inline literal keeps the hot exit free of a
  // cross-function call; __zcFin is reached only on failure.
  functionDefParts.push(
    `var _e=[];`,
    `var _d=input;`,
    slowCode,
    `if(_e.length===0){return{success:true,data:_d};}`,
    `return __zcFin(_e,_d);`,
    `}`,
  );

  const functionDef = functionDefParts.join("\n");

  return {
    code: buildCode(),
    functionDef,
    refCount: options?.refCount ?? 0,
    usedHelpers: ctx.usedHelpers,
    fastFnName,
    // Partial fast path (default/catch/coerce) or none: a false fc result does
    // not imply rejection, so `.is()` derives from safeParse(input).success.
    fastTotal: false,
  };
}

/**
 * Find every non-root recursion target (a `recursionTarget` node, refId ≥ 1)
 * reachable from `root`, mapping refId → the inner IR to host as a standalone
 * validator. The root target (refId 0) is the schema's own function and is
 * never wrapped, so it never appears here. The same target may be wrapped at
 * several sites (a recursive schema reached from sibling positions); the first
 * inner wins — they are structurally identical extractions of one schema.
 */
function collectRecursionTargets(root: SchemaIR): Map<number, SchemaIR> {
  const out = new Map<number, SchemaIR>();
  const seen = new Set<SchemaIR>();
  const walk = (ir: SchemaIR): void => {
    if (seen.has(ir)) return;
    seen.add(ir);
    if (ir.type === "recursionTarget" && !out.has(ir.refId)) {
      out.set(ir.refId, ir.inner);
    }
    for (const child of childIRs(ir)) walk(child);
  };
  walk(root);
  return out;
}

/** Direct child SchemaIR nodes, covering every node type (including the new wrapper). */
function childIRs(ir: SchemaIR): readonly SchemaIR[] {
  switch (ir.type) {
    case "object":
      return Object.values(ir.properties);
    case "array":
      return [ir.element];
    case "tuple":
      return ir.rest === null ? ir.items : [...ir.items, ir.rest];
    case "record":
    case "map":
      return [ir.keyType, ir.valueType];
    case "set":
      return [ir.valueType];
    case "union":
    case "discriminatedUnion":
      return ir.options;
    case "intersection":
      return [ir.left, ir.right];
    case "optional":
    case "nullable":
    case "readonly":
    case "default":
    case "catch":
    case "effect":
    case "recursionTarget":
      return [ir.inner];
    case "pipe":
      return [ir.in, ir.out];
    default:
      return [];
  }
}
