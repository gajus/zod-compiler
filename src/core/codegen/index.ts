import type { SchemaIR } from "../types.js";
import type {
  CodeGenContext,
  CodeGenResult,
  CodegenMode,
  GeneratedConstant,
  RecTargetGen,
} from "./context.js";
import {
  fastResultIsInput,
  generateBuild,
  nestedNeedsProtoScrub,
  rebuildsOutput,
} from "./build-path.js";
import {
  declareFastTemps,
  emitRetainedMethod,
  emitRfDelegate,
  emitRuntimeHelper,
  hasMutation,
  needsProtoScrub,
  RETAINED_SCHEMA_VAR,
} from "./context.js";
import type { SharedSchemaPlan } from "./dedupe.js";
import { ZC_PROTO_SCRUB_DECL } from "./issue-decls.js";
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
   * {@link CodeGenResult.usesRetainedSchema}.
   */
  compact?: boolean | undefined;
  /** Internal file-pipeline hook for pooling exact constant initializers across validators. */
  onConstant?: ((constant: GeneratedConstant) => void) | undefined;
  /** Internal exact-initializer plan used by the file pipeline's final generation pass. */
  sharedConstantNames?: ReadonlyMap<string, string> | undefined;
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
    onConstant: options?.onConstant,
    sharedConstantNames: options?.sharedConstantNames,
  };

  // Slow-walk sharing. The plan already excludes any shape that would reach for
  // this export's `__rf[]`, and a shared walk returns its parsed value, so a
  // rewriting shape (a stripping object above all) delivers its result through
  // the call. Nothing left to gate on here.
  if (options?.sharedSchemas !== undefined) {
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
  const fastValueCache = ctx.valueCache && new Map(ctx.valueCache);
  const fastRecName = ctx.recFastName;
  // A schema that rebuilds its output never takes a by-reference shortcut:
  // `fastResultIsInput` withholds `data: input` and the published `fc` alike,
  // so its root expression is only ever consumed as a VERDICT — by `.is()`. It
  // is therefore generated as an acceptance predicate (see FastGen.acceptance),
  // which differs from the by-reference form only at `.default()` nodes and is
  // what lets a defaulted schema keep a zero-allocation `.is()`.
  const acceptance = rebuildsOutput(ir);
  const fg = createFastGen("input", ctx, false, undefined, undefined, acceptance);
  let fastExpr = generateFast(ir, fg);
  if (fastExpr !== null && hasNonRootTargets) {
    // Host each non-root recursion target as a boolean fast-check helper. A
    // single fast-ineligible target (e.g. one whose recursive shape contains a
    // fallback) disables the WHOLE fast path: the root expression already emits
    // calls to these names, so a missing body would dangle. The shared
    // rollback below then restores clean state for the slow-only path.
    for (const t of ctx.recTargets.values()) {
      if (t.isRoot) continue;
      const targetGen = createFastGen("input", ctx, false, undefined, undefined, acceptance);
      const body = generateFast(t.inner as SchemaIR, targetGen);
      if (body === null) {
        fastExpr = null;
        break;
      }
      ctx.preamble.push(
        `function ${t.fastName}(input){${declareFastTemps(targetGen.scope)}return ${body};}`,
      );
    }
  }
  if (fastExpr === null) {
    // The build pass also invokes generateFast for passthrough subtrees. Its
    // recursive calls must decline once this rollback removes their hosts;
    // the pre-allocated names in recTargets alone do not prove they exist.
    ctx.fastRecursionDisabled = true;
    ctx.preamble.length = fastPreambleLen;
    ctx.regexCache = fastRegexCache;
    if (fastEffectCache === undefined) delete ctx.effectFnCache;
    else ctx.effectFnCache = fastEffectCache;
    // Value declarations the abandoned walk emitted are truncated above, so
    // their cache entries would name identifiers that no longer exist.
    if (fastValueCache === undefined) delete ctx.valueCache;
    else ctx.valueCache = fastValueCache;
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
    ctx.preamble.push(
      `function ${fastFnName}(input){${declareFastTemps(fg.scope)}return ${fastExpr};}`,
    );
    fastExpr = `${fastFnName}(input)`;
  }

  // Build Path: one pass that validates and assembles rewritten output, bailing
  // on the first failure (see build-path). Null unless every mutation in the
  // schema is modelled — so this emits nothing for the mutation-free schemas
  // the compact branch takes.
  const buildFnName = generateBuild(ir, ctx);

  // A zodDelegate with a rebuilding inner exists only to accelerate that
  // build. If an unmodelled descendant made the all-or-nothing build decline,
  // preserve the old root-fallback shape instead of wrapping the same pristine
  // Zod call in an issues array/copy/finalizer. This keeps unsupported object
  // intersections neutral rather than making compilation slower than Zod.
  if (ir.type === "zodDelegate" && rebuildsOutput(ir.inner) && buildFnName === null) {
    ctx.preamble.length = 0;
    ctx.usedHelpers.clear();
    ctx.regexCache.clear();
    ctx.effectFnCache?.clear();
    ctx.valueCache?.clear();
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

  // `.is()` for a build-path schema is the fast expression — stripping reshapes
  // the payload, never the verdict, and a `.default()` is covered too: the build
  // path is only ever taken by a rebuilding schema, whose expression was
  // generated in acceptance mode (`acceptance` above) and so accepts the absent
  // value the substitution stands in for.
  const buildIsFnName = fastFnName;

  const baseRefCount = options?.refCount ?? 0;

  // Compact mode: a mutation-free schema with a TOTAL fast path needs no
  // compiled slow walk — its only purpose is reproducing zod's issues on
  // failure, and the original zod schema (retained in `output: "compact"`) does
  // that exactly. Emit the fast check and, on failure, delegate to a fresh root
  // RefEntry (the schema itself) via the pristine safeParse method capture, then
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
    // `data: input` verbatim, with no compiled walk to fall back on — so a
    // schema whose output needs an own `__proto__` removed cannot use it.
    !needsProtoScrub(ir) &&
    !nestedNeedsProtoScrub(ir) &&
    !hasNonRootTargets
  ) {
    const delegate = emitRetainedMethod(ctx);
    ctx.usedHelpers.add("__zcFinZ");
    return {
      code: ["/* zod-compiler */", ...ctx.preamble].join("\n"),
      functionDef: [
        `function ${fnName}(input){`,
        `if(${fastExpr}){return{success:true,data:input};}`,
        `return __zcFinZ(${delegate},${RETAINED_SCHEMA_VAR},input);`,
        `}`,
      ].join("\n"),
      refCount: baseRefCount,
      usedHelpers: ctx.usedHelpers,
      fastFnName,
      // Mutation-free total fast path: fc(input) ⟺ accepts(input), so `.is()`
      // installs fc directly (compact never weakens the guard).
      fastTotal: true,
      usesRetainedSchema: true,
    };
  }

  // Compact + Build Path: same bargain for a schema with modelled rewrites. The
  // build pass still has to run (it produces the payload, which zod's schema
  // would only reproduce by parsing again), but the compiled issue walk is what
  // compact drops, and delegating that to the retained zod schema costs a few
  // bytes.
  if (
    options?.compact === true &&
    buildFnName !== null &&
    ctx.buildFailName !== undefined &&
    !hasNonRootTargets
  ) {
    const delegate = emitRetainedMethod(ctx);
    ctx.usedHelpers.add("__zcFinZ");
    const built = `__bd_${ctx.counter++}`;
    return {
      code: ["/* zod-compiler */", ...ctx.preamble].join("\n"),
      functionDef: [
        `function ${fnName}(input){`,
        `var ${built}=${buildFnName}(input);`,
        `if(${built}!==${ctx.buildFailName}){return{success:true,data:${built}};}`,
        `return __zcFinZ(${delegate},${RETAINED_SCHEMA_VAR},input);`,
        `}`,
      ].join("\n"),
      refCount: baseRefCount,
      usedHelpers: ctx.usedHelpers,
      fastFnName: null,
      fastTotal: false,
      isFnName: buildIsFnName,
      usesRetainedSchema: true,
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
  const slowCode = rootRef !== undefined ? `_d=${rootRef.name}(_d,[],_e);` : generateSlow(ir, sg);

  const buildCode = (): string => ["/* zod-compiler */", ...ctx.preamble].join("\n");

  const functionDefParts = [`function ${fnName}(input){`];

  // Build Path: every mutation is modelled, so one pass can validate and
  // assemble the output together and bail on the first failure, leaving the
  // issue-producing walk deferred behind `.error` (see build-path).
  // The fast check stays out of `safeParse` entirely — running it first would
  // read every property twice — but it is still an EXACT acceptance predicate
  // (stripping reshapes the output, never the verdict), so `.is()` installs it.
  if (buildFnName !== null && ctx.buildFailName !== undefined) {
    ctx.usedHelpers.add("__zcFinD");
    const built = `__bd_${ctx.counter++}`;
    // A self-recursive walk calls this validator BY NAME (slowRecursiveRef),
    // and that binding exists only inside the named function expression — so
    // there the walk stays a per-call closure. Everything else hosts it in the
    // preamble, keeping safeParse to three statements. Mirrors the same split
    // in the mutation-free branch below.
    const recursive = slowCode.includes(fnName);
    let deferred: string;
    if (recursive) {
      deferred = `__zcFinD(function(input){var _e=[];\nvar _d=input;\n${slowCode}\nreturn _e;},input)`;
    } else {
      const walkName = `__sw_${ctx.counter++}`;
      ctx.preamble.push(
        `function ${walkName}(input){var _e=[];\nvar _d=input;\n${slowCode}\nreturn _e;}`,
      );
      deferred = `__zcFinD(${walkName},input)`;
    }
    return {
      code: buildCode(),
      functionDef: [
        `function ${fnName}(input){`,
        `var ${built}=${buildFnName}(input);`,
        `if(${built}!==${ctx.buildFailName}){return{success:true,data:${built}};}`,
        `return ${deferred};`,
        `}`,
      ].join("\n"),
      refCount: options?.refCount ?? 0,
      usedHelpers: ctx.usedHelpers,
      // No by-reference shortcut: `data` is the freshly built object, so
      // parse() must go through safeParse rather than returning its input.
      fastFnName: null,
      // `fastTotal` qualifies `fastFnName`, which is null here; the predicate
      // travels in `isFnName` instead.
      fastTotal: false,
      isFnName: buildIsFnName,
    };
  }

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

  if (fastExpr !== null && !hasMutation(ir) && !nestedNeedsProtoScrub(ir)) {
    // The by-reference shortcut hands back the input verbatim, which a loose or
    // catchall object — or a record — must not do while it still carries an own
    // `__proto__` (see ZC_PROTO_SCRUB_DECL). The fast check itself stays a pure
    // predicate, so `fc(input) ⟺ zod accepts` still holds and the deferred error
    // path below is untouched; only the value handed back is filtered. The cost
    // is one `hasOwnProperty` per successful parse of those shapes.
    const fastData = needsProtoScrub(ir)
      ? `${emitRuntimeHelper(ctx, "__zcPs", ZC_PROTO_SCRUB_DECL)}(input)`
      : "input";
    // Mutation-free schemas with a fast path: a fast-check failure can never
    // become a slow-path success (both are generated from the same checks —
    // unlike default/catch schemas, whose partial fast path requires value
    // presence while the slow path SUCCEEDS by applying the fallback).
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
        `if(${fastExpr}){return{success:true,data:${fastData}};}`,
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
        `if(${fastExpr}){return{success:true,data:${fastData}};}`,
        `return __zcFinD(${walkName},input);`,
        `}`,
      );
    }
    return {
      code: buildCode(),
      functionDef: functionDefParts.join("\n"),
      refCount: options?.refCount ?? 0,
      usedHelpers: ctx.usedHelpers,
      // `fc` is a sound VERDICT here either way, but publishing it also promises
      // `parse()` may return the input — which a scrubbed output cannot (see
      // fastResultIsInput). `.is()` reads only the verdict, so it takes the
      // predicate through `isFnName` whether or not `fc` is withheld —
      // `fastTotal` below qualifies `fastFnName` alone.
      fastFnName: fastResultIsInput(ir) ? fastFnName : null,
      // Total predicate: mutation-free fast path, fc(input) ⟺ accepts(input).
      // generateIIFE installs fc directly as the zero-allocation `.is()`.
      fastTotal: true,
      isFnName: fastFnName,
    };
  }

  if (fastExpr !== null && fastResultIsInput(ir)) {
    // Partial fast path (default/catch/... present-value shortcut): the slow
    // path must run eagerly — it can succeed where the fast check failed.
    //
    // Withheld when the schema rebuilds its output: there the fast check is a
    // sound VERDICT but says nothing about the payload, and `data:input` would
    // hand back the unstripped input. Such schemas reach here only when the
    // build path declined them, so the eager walk produces the output instead.
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
    // `fc` carries a stronger contract than "accepts": `__zcMkv` returns the
    // INPUT from `parse()`/`parseAsync()`/`~standard` whenever it holds, so it
    // may only be published when a passing check implies `data === input`. A
    // rebuilding schema breaks that even though its safeParse is correct, and so
    // does a union whose options can rewrite — see `fastResultIsInput` for both.
    // Same guard as the `data: input` shortcut above, which is the other reader
    // of the same contract.
    fastFnName: fastResultIsInput(ir) ? fastFnName : null,
    // Partial fast path (default/catch) or none (including coercion): a false fc
    // result does not imply rejection, so `.is()` derives from
    // safeParse(input).success.
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
    case "zodDelegate":
      return [ir.inner];
    case "pipe":
      return [ir.in, ir.out];
    default:
      return [];
  }
}
