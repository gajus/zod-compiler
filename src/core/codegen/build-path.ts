/**
 * Build Path: one uninstrumented pass that VALIDATES and BUILDS rewritten
 * output together, abandoning the whole parse at the first failing check.
 *
 * `z.object()` strips unknown keys, so a successful parse cannot return the
 * input by reference — it must produce a fresh object. That rules out the Fast
 * Path (whose contract is `data === input`), and before this the only remaining
 * option was the eager slow walk: a fully instrumented traversal that collects
 * issues on every parse, valid or not.
 *
 * Two passes are wasteful in either direction. Validating first and building
 * afterwards reads every property twice (measured 29.7 ns vs 21.6 for the slow
 * walk on a 6-field object). Building with issue collection pays the
 * instrumentation even when nothing fails. Doing both in ONE pass, with a
 * sentinel instead of an issues array, beats both — and a failure costs only
 * the checks up to the first bad one, because the issue-producing walk is
 * deferred into `.error` exactly as `__zcFinD` does for mutation-free schemas:
 *
 *              object clean   object invalid   array(8) invalid
 *   slow walk       21.6 ns         30.4 ns           197.5 ns
 *   build path      18.1 ns          7.7 ns             9.8 ns
 *
 * A subtree that rebuilds nothing is validated with its existing Fast Path
 * expression and passed through by reference, so only nodes that genuinely
 * produce a new value need code here; anything else returns null and keeps the
 * eager walk.
 *
 * Coverage is what decides whether this pass is reached at all, because it is
 * all-or-nothing per schema: ONE unmodelled node anywhere in the tree costs the
 * whole schema its single-pass parse. Modelled, beyond the stripping containers
 * this started with: array size checks and `.refine()`, object-level `.refine()`,
 * `.default()` substitution, ordered string rewrites (`.trim()`,
 * `.toLowerCase()`), sync `.transform()`, `z.stringbool()`, and the five native
 * coercions (`string`, `number`, `boolean`, `bigint`, `date`). Still declined, via
 * {@link mutatesBeyondStrip} — `.catch()` (its callback wants the inner schema's
 * issue list, which this pass never builds), `z.url()`, and `superRefine`.
 */

import type { ObjectIR, RefineEffectCheckIR, SchemaIR, StringBoolIR } from "../types.js";
import type { CodeGenContext, FastScope } from "./context.js";
import {
  declareFastTemps,
  emitEffectCallable,
  emitEffectFn,
  emitPooledConstant,
  emitRuntimeHelper,
  emitTemp,
  escapeString,
  hasMutation,
  keyMembershipTest,
  literalToJs,
  outputAlwaysDefined,
  rejectsUndefined,
} from "./context.js";
import { createFastGen, generateFast } from "./fast-path.js";
import { EXTRACT_CAP, estimateFastCost, MIN_EXTRACT, predictedInlineSize } from "./fast-size.js";
import { ZC_HOP_DECL, ZC_PLAIN_DECL } from "./issue-decls.js";
import { defaultValueExpr, needsPostInnerDefault } from "./schemas/default.js";
import { parsedProperties } from "./schemas/object.js";
import { innerAppliesDefaultOnUndefined } from "./schemas/optional.js";
import { fastStringCheck } from "./schemas/string.js";
import { emitStringBoolMap, stringBoolUsesInline } from "./schemas/string-bool.js";

/** Statements that leave the built value in `value`, or `return <FAIL>` on failure. */
interface Built {
  code: string;
  value: string;
}

interface BuildGen {
  ctx: CodeGenContext;
  /** Identifier of the per-validator FAIL sentinel. */
  fail: string;
  /** `var` temps and running emitted size of the function being assembled. */
  scope: FastScope;
  /**
   * May THIS node be hosted in its own function? False for the node a hosted
   * build was created for — it already IS that function, so re-hosting it would
   * recurse forever. Children are always extractable, letting an oversized
   * helper split further.
   */
  extractable: boolean;
  /** Nodes of the root schema that rebuild (see rebuildSet). */
  rebuilds: ReadonlySet<SchemaIR>;
}

/**
 * Which nodes of `root` produce a value that is not their input — a stripping
 * object, coercion, codec, default, overwrite or transform, including
 * containers that contain one. Everything else can be validated in place and
 * passed through, which is what keeps this generator small.
 *
 * Computed as a fixpoint rather than a plain walk because of recursion: a
 * `recursiveRef` is a back-edge with no children, so a local walk reads false
 * for it and would pass the whole recursive subtree through by reference —
 * leaving every nested value unstripped while the outermost one was rebuilt.
 * Resolving the ref against its target closes the cycle, and iterating to a
 * fixpoint settles the mutual dependency between the two.
 */
function rebuildSet(root: SchemaIR): ReadonlySet<SchemaIR> {
  const targets = new Map<number, SchemaIR>([[0, root]]);
  const nodes: SchemaIR[] = [];
  const seen = new Set<SchemaIR>();
  const collect = (node: SchemaIR): void => {
    if (seen.has(node)) return;
    seen.add(node);
    nodes.push(node);
    if (node.type === "recursionTarget") targets.set(node.refId, node.inner);
    for (const child of children(node)) collect(child);
  };
  collect(root);

  const rebuilds = new Set<SchemaIR>();
  for (let changed = true; changed;) {
    changed = false;
    for (const node of nodes) {
      if (rebuilds.has(node)) continue;
      const target = node.type === "recursiveRef" ? targets.get(node.refId ?? 0) : undefined;
      const rebuild =
        (node.type === "object" && node.stripUnknownKeys === true) ||
        // A freezing readonly's output is `Object.freeze(inner)` — a value the
        // caller never handed us, so it must be BUILT rather than passed
        // through. Marking it here is also what makes `rebuildsOutput` true and
        // so withholds every by-reference shortcut above it.
        (node.type === "readonly" && node.freeze === true) ||
        // `.default()` substitutes its own value for `undefined`, so its output
        // is not its input even when the inner schema passes through — it must
        // never be handed to `passthrough`, whose fast check would reject the
        // absent value outright.
        node.type === "default" ||
        // `z.stringbool()` replaces its accepted string with a boolean.
        node.type === "stringBool" ||
        // An overwrite effect (`.trim()`, `.toLowerCase()`) rewrites the string,
        // so the node's output is a new value: it has to be BUILT rather than
        // validated in place (see buildString).
        (node.type === "string" &&
          (node.coerce === true || node.checks.some((c) => c.kind === "overwrite_effect"))) ||
        ((node.type === "number" ||
          node.type === "boolean" ||
          node.type === "bigint" ||
          node.type === "date") &&
          node.coerce === true) ||
        // `.transform(fn)` replaces the value with the callback's result.
        node.type === "effect" ||
        (target !== undefined && rebuilds.has(target)) ||
        children(node).some((child) => rebuilds.has(child));
      if (rebuild) {
        rebuilds.add(node);
        changed = true;
      }
    }
  }
  return rebuilds;
}

/** Does `ir`, taken as a whole schema, produce a value that is not its input? */
export function rebuildsOutput(ir: SchemaIR): boolean {
  return rebuildSet(ir).has(ir);
}

/**
 * Does a PASSING fast check prove that the parse returns its own input?
 *
 * This is the contract behind every by-reference shortcut: `safeParse`'s
 * `if(fc(input)) return {success:true,data:input}` and, through `fc` in
 * `__zcMkv`, `parse()` / `parseAsync()` / `~standard.validate()`. It is strictly
 * stronger than "the fast check is sound", and two things break it:
 *
 *  1. The schema REBUILDS its output. A stripping object is the common case, and
 *     it is why `z.object({ a: z.number().catch(0) })` — a strip object the
 *     build pass declines because of the `.catch()` — used to answer
 *     `parse({a: 1, b: 2})` with the UNSTRIPPED input while its own `safeParse`
 *     correctly returned `{a: 1}`.
 *
 *  2. A plain `z.union()` with a MUTATING option. The fast form is an `||` chain,
 *     which reports that SOME option accepts the input; zod returns the value
 *     produced by the FIRST option that succeeds. Those differ as soon as an
 *     earlier option would have claimed the input and rewritten it —
 *     `z.union([z.string().catch("c"), z.number()])` answers `"c"` for every
 *     input, catch being infallible, while the chain matches `1` against the
 *     number arm and hands back `1`. A DISCRIMINATED union is exempt: its
 *     dispatch selects exactly one option, so which arm zod runs is never in
 *     doubt (and a rewriting object option is caught by (1) anyway).
 *
 * Withheld here rather than in `fastUnion` on purpose: the `||` chain is still a
 * correct VERDICT, which is all a nested conjunct or a `.is()` guard needs, so
 * declining to emit it would cost every union-of-objects its fast path (and the
 * size-gated `__fo_` split) to fix a shortcut that only the root takes.
 */
export function fastResultIsInput(ir: SchemaIR): boolean {
  if (rebuildsOutput(ir)) return false;
  const seen = new Set<SchemaIR>();
  const ordered = (node: SchemaIR): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (node.type === "union" && node.options.some(hasMutation)) return true;
    return children(node).some(ordered);
  };
  return !ordered(ir);
}

/**
 * True when the subtree mutates for any reason the build pass cannot reproduce —
 * `.catch()`, `z.url()`, `superRefine`. Those rewrite values in ways this pass
 * (which validates, coerces, decodes string booleans, substitutes declared
 * defaults, applies ordered string rewrites and copies) does not model, so the
 * schema keeps the eager walk.
 */
function mutatesBeyondStrip(ir: SchemaIR): boolean {
  return mutatesHere(ir) || children(ir).some(mutatesBeyondStrip);
}

/**
 * Does this node rewrite values on its own account (ignoring its children, and
 * ignoring the reshaping a strip object does)? Mirrors the node-local half of
 * `hasMutation`; the recursion above supplies the other half.
 */
function mutatesHere(ir: SchemaIR): boolean {
  switch (ir.type) {
    case "string":
      // Coercion and overwrite effects are absent: `buildString` applies them
      // in order. A `z.url()` check still is not — it trims, normalizes and
      // needs its own normalization/error semantics.
      return (
        superRefines(ir.checks) ||
        ir.checks.some((c) => c.kind === "string_format" && c.format === "url")
      );
    case "number":
      return superRefines(ir.checks);
    case "boolean":
    case "bigint":
    case "date":
      return false;
    // `default` and `effect` are absent: substituting a constant for `undefined`
    // and applying a sync transform are both modelled (see buildDefault /
    // buildEffect), and their inners are reached through `children`.
    //
    // `catch` is NOT: its catchValue callback receives a ctx carrying the inner
    // schema's collected issues, and this pass produces a sentinel instead of an
    // issue list — there is nothing to hand it.
    case "catch":
    case "fallback":
      return true;
    case "object":
    case "array":
      return superRefines(ir.checks);
    default:
      return false;
  }
}

function superRefines(checks: readonly { kind: string }[] | undefined): boolean {
  return checks !== undefined && checks.some((c) => c.kind === "super_refine_effect");
}

function children(ir: SchemaIR): readonly SchemaIR[] {
  switch (ir.type) {
    case "object":
      return ir.catchall
        ? [...Object.values(ir.properties), ir.catchall]
        : Object.values(ir.properties);
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

/**
 * Host the whole schema as `function NAME(input){…}` returning the built value
 * or the FAIL sentinel. Returns the function name, or null when the schema is
 * not expressible as a single build pass.
 */
export function generateBuild(ir: SchemaIR, ctx: CodeGenContext): string | null {
  const rebuilds = rebuildSet(ir);
  if (!rebuilds.has(ir) || mutatesBeyondStrip(ir)) return null;
  const fail = emitFailSentinel(ctx);
  const scope: FastScope = { temps: [], used: 0 };
  const built = build(ir, "input", { ctx, extractable: false, fail, rebuilds, scope });
  if (built === null) return null;
  const name = emitTemp(ctx, "vb");
  ctx.preamble.push(
    `function ${name}(input){${declareFastTemps(scope)}${built.code}return ${built.value};}`,
  );
  return name;
}

/**
 * The build path's FAIL marker: an object compared by identity, which the build
 * function returns in place of a value and `safeParse` tests for.
 *
 * Pooled at file level rather than declared per validator. Its whole contract is
 * "nothing a parse can produce equals this", and that is a property of the
 * object's freshness, not of how many there are — so one `{}` serves every
 * rebuilding validator in the file, where before each allocated its own at
 * module init. Pooling by initializer text is safe for the same reason: the only
 * way a merge could hurt is if some other `{}` constant were ever RETURNED by a
 * build function, and the pool's other members are lookup tables and value
 * lists, which are only ever read from.
 */
function emitFailSentinel(ctx: CodeGenContext): string {
  ctx.buildFailName ??= emitPooledConstant(ctx, "Bf", "bf", "{}");
  return ctx.buildFailName;
}

/**
 * Statements producing the built value of `ir` read from `input`, or null.
 *
 * Size-gated exactly like the fast path: once inlining `ir` would push the
 * function being assembled past EXTRACT_CAP, the sub-build is hosted as its own
 * `__vb_N(p)` returning value-or-FAIL and replaced by a call. Without this a
 * deeply nested schema emits one enormous build function — measured at 113 KB
 * and 354 KB on the deep fixtures — far past the bytecode size where V8 stops
 * running TurboFan on it, which would forfeit the speed this path exists for.
 */
function build(ir: SchemaIR, input: string, g: BuildGen): Built | null {
  // Resolved before the passthrough shortcut below. A back-edge carries no
  // children, so `rebuildsOutput` reads false for it — and passing it through by
  // reference would leave every nested recursive value unstripped while the
  // outermost one was rebuilt.
  if (ir.type === "recursiveRef") return buildRecursiveCall(ir.refId ?? 0, input, g);
  if (ir.type === "recursionTarget") return buildRecursionTarget(ir, input, g);
  if (!g.rebuilds.has(ir)) return passthrough(ir, input, g);

  const cache = (g.ctx.fastSizeCache ??= new WeakMap<SchemaIR, number>());
  if (
    g.extractable &&
    g.scope.used + predictedInlineSize(ir, input.length, cache) > EXTRACT_CAP &&
    (g.scope.used > EXTRACT_CAP || estimateFastCost(ir, cache) >= MIN_EXTRACT)
  ) {
    const hosted = hostBuild(ir, g);
    if (hosted !== null) {
      const slot = local(g, "bh");
      const code = `${slot}=${hosted}(${input});if(${slot}===${g.fail})return ${g.fail};`;
      g.scope.used += code.length;
      return { code, value: slot };
    }
  }

  // This node's extraction decision is made; its descendants get to make their
  // own, so an oversized hosted helper keeps splitting.
  const before = g.scope.used;
  const out = buildInline(ir, input, { ...g, extractable: true });
  if (out !== null) g.scope.used = before + out.code.length;
  return out;
}

/** Host `ir`'s build in its own function over a fresh parameter; returns its name. */
function hostBuild(ir: SchemaIR, g: BuildGen): string | null {
  const param = emitTemp(g.ctx, "bp");
  const scope: FastScope = { temps: [], used: 0 };
  const inner = build(ir, param, { ...g, extractable: false, scope });
  if (inner === null) return null;
  const name = emitTemp(g.ctx, "vb");
  g.ctx.preamble.push(
    `function ${name}(${param}){${declareFastTemps(scope)}${inner.code}return ${inner.value};}`,
  );
  return name;
}

function buildInline(ir: SchemaIR, input: string, g: BuildGen): Built | null {
  switch (ir.type) {
    case "object":
      return buildObject(ir, input, g);
    case "array":
      return buildArray(ir, input, g);
    case "tuple":
      return buildTuple(ir, input, g);
    case "record":
      return buildRecord(ir, input, g);
    case "optional":
      // A default further down the chain consumes undefined into a value, so
      // the `undefined → undefined` shortcut must not fire — same rule (and
      // same helper) the slow and fast paths already apply.
      return innerAppliesDefaultOnUndefined(ir.inner)
        ? build(ir.inner, input, g)
        : buildSentinel(ir.inner, input, g, "===undefined", "undefined");
    case "nullable":
      // `null` short-circuits unconditionally in zod, whatever the inner is;
      // undefined flows through, so an inner default still fires.
      return buildSentinel(ir.inner, input, g, "===null", "null");
    case "default":
      return buildDefault(ir, input, g);
    case "string":
      return buildString(ir, input, g);
    case "stringBool":
      return buildStringBool(ir, input, g);
    case "number":
    case "boolean":
    case "bigint":
    case "date":
      return buildCoercedPrimitive(ir, input, g);
    case "effect":
      return buildEffect(ir, input, g);
    case "readonly":
      return buildReadonly(ir, input, g);
    case "zodDelegate":
      return build(ir.inner, input, g);
    case "union":
      return buildUnion(ir, input, g);
    case "discriminatedUnion":
      return buildDiscriminatedUnion(ir, input, g);
    default:
      // A rebuilding intersection, map or set: expressible in principle, but
      // each needs its own output-shaping rules, so they keep the eager walk
      // until there is a measured reason to add them.
      return null;
  }
}

/**
 * Host the target's build once under a name registered BEFORE its body is
 * generated, so the back-edges inside that body resolve to it.
 */
function buildRecursionTarget(
  ir: SchemaIR & { type: "recursionTarget" },
  input: string,
  g: BuildGen,
): Built | null {
  const table = (g.ctx.buildRecNames ??= new Map<number, string>());
  if (!table.has(ir.refId)) {
    const name = emitTemp(g.ctx, "vbr");
    table.set(ir.refId, name);
    const param = emitTemp(g.ctx, "bp");
    const scope: FastScope = { temps: [], used: 0 };
    const inner = build(ir.inner, param, { ...g, extractable: false, scope });
    if (inner === null) {
      table.delete(ir.refId);
      return null;
    }
    g.ctx.preamble.push(
      `function ${name}(${param}){${declareFastTemps(scope)}${inner.code}return ${inner.value};}`,
    );
  }
  return buildRecursiveCall(ir.refId, input, g);
}

/** Call the hosted build for a recursion target, propagating its FAIL. */
function buildRecursiveCall(refId: number, input: string, g: BuildGen): Built | null {
  const name = g.ctx.buildRecNames?.get(refId);
  if (name === undefined) return null;
  const slot = local(g, "bh");
  return {
    code: `${slot}=${name}(${input});if(${slot}===${g.fail})return ${g.fail};`,
    value: slot,
  };
}

/**
 * Try each option in declaration order and take the first that builds — which
 * is what zod's union does with the first option that parses.
 *
 * Every option is HOSTED rather than inlined, and that is load-bearing: a
 * failing build signals with `return FAIL`, which inside the enclosing function
 * would abandon the whole parse instead of moving on to the next option. Behind
 * a call, the same signal is just a value to test.
 *
 * PLAIN unions only. A discriminated union must not reach here: zod resolves it
 * by dispatch, not by probing, and the two disagree — see
 * {@link buildDiscriminatedUnion}.
 */
function buildUnion(ir: SchemaIR & { type: "union" }, input: string, g: BuildGen): Built | null {
  const hosted: string[] = [];
  for (const option of ir.options) {
    const fn = g.rebuilds.has(option) ? hostBuild(option, g) : hostPassthrough(option, g);
    if (fn === null) return null;
    hosted.push(fn);
  }
  if (hosted.length === 0) return null;

  const out = local(g, "bu");
  let code = `${out}=${hosted[0] as string}(${input});`;
  for (const fn of hosted.slice(1)) {
    code += `if(${out}===${g.fail}){${out}=${fn}(${input});}`;
  }
  code += `if(${out}===${g.fail})return ${g.fail};`;
  return { code, value: out };
}

/**
 * Dispatch on the discriminator and build ONLY the option that value selects,
 * failing outright when it selects none — mirroring zod, which resolves the
 * option through a `discriminator value → option` map built from each option's
 * `propValues` and pushes `invalid_union` ("No matching discriminator") without
 * ever running an option's parse when the lookup misses.
 *
 * Probing the options in order like {@link buildUnion} does is NOT equivalent,
 * because an option can accept more than its own dispatch values. A wrapper that
 * substitutes a value contributes only the value it wraps to `propValues` while
 * its parse also accepts the input it substitutes FOR:
 * `z.literal("a").default("a")` dispatches on `"a"` alone yet parses a MISSING
 * discriminator, so sequential probing accepted `{v:"x"}` — output `{t:"a",v:"x"}`
 * — where zod rejects it. `.prefault()` and `.catch()` have the same shape, and
 * only escape it because neither reaches this pass today (a prefaulted schema
 * delegates to zod wholesale, and `.catch()` is refused by
 * {@link mutatesBeyondStrip}); a `.default()` is exactly what pulls the build
 * path in. The switch cannot drift that way: the dispatch table IS zod's, so an
 * unlisted discriminator reaches `default:` and fails, whatever the options
 * would have accepted on their own.
 *
 * The reverse — rejecting what zod accepts — is why `.optional()`/`.nullable()`
 * discriminators stay compiled rather than being refused here: their
 * `undefined`/`null` are in `propValues`, so they arrive as ordinary cases.
 *
 * Object-ness is proved BEFORE the discriminator is read, both because zod
 * rejects a non-object with its own `invalid_type` ahead of the lookup and
 * because the property read would throw on `null`/`undefined`.
 */
function buildDiscriminatedUnion(
  ir: SchemaIR & { type: "discriminatedUnion" },
  input: string,
  g: BuildGen,
): Built | null {
  const out = local(g, "bd");
  // One hosted build per REACHABLE option, keyed by option index: a multi-value
  // literal (`z.literal(["a","c"])`) contributes several cases selecting the
  // same option, and they share the one function rather than emitting it twice.
  const hostedByOption = new Map<number, string>();
  let arms = "";
  for (const { value, option: index } of ir.cases) {
    let fn = hostedByOption.get(index);
    if (fn === undefined) {
      const option = ir.options[index];
      if (option === undefined) return null;
      const hosted = g.rebuilds.has(option) ? hostBuild(option, g) : hostPassthrough(option, g);
      if (hosted === null) return null;
      fn = hosted;
      hostedByOption.set(index, fn);
    }
    arms += `case ${literalToJs(value)}:${out}=${fn}(${input});break;`;
  }
  if (arms === "") return null;

  return {
    code:
      `if(typeof ${input}!=="object"||${input}===null||Array.isArray(${input}))return ${g.fail};` +
      `switch(${input}[${escapeString(ir.discriminator)}]){${arms}default:return ${g.fail};}` +
      `if(${out}===${g.fail})return ${g.fail};`,
    value: out,
  };
}

/**
 * Host a non-rebuilding option as `value-or-FAIL`, so a union can probe it with
 * the same protocol as a rebuilding one.
 */
function hostPassthrough(ir: SchemaIR, g: BuildGen): string | null {
  const param = emitTemp(g.ctx, "bp");
  const scope: FastScope = { temps: [], used: 0 };
  const expr = generateFast(ir, createFastGen(param, g.ctx, true, scope));
  if (expr === null) return null;
  const name = emitTemp(g.ctx, "vp");
  g.ctx.preamble.push(
    `function ${name}(${param}){${declareFastTemps(scope)}return ${expr === "true" ? param : `(${expr})?${param}:${g.fail}`};}`,
  );
  return name;
}

/** Validate in place with the Fast Path and hand the input straight back. */
function passthrough(ir: SchemaIR, input: string, g: BuildGen): Built | null {
  const scoped = createFastGen(input, g.ctx, true, g.scope);
  const expr = generateFast(ir, scoped);
  if (expr === null) return null;
  return { code: expr === "true" ? "" : `if(!(${expr}))return ${g.fail};`, value: input };
}

/**
 * Rebuild from the declared keys. Sound for a stripping object (that IS the
 * output) and for a strict one (unknown keys are rejected, so the declared keys
 * are the whole key set). A loose object or one with a `.catchall()` keeps keys
 * this pass does not enumerate, so those bail.
 */
/**
 * Freeze the inner's built value, matching zod's `Object.freeze(payload.value)`.
 *
 * Sound only because `freeze` is set exclusively over a stripping object, whose
 * build ALWAYS allocates (`buildObject` assembles a fresh `__bo_N`) — so the
 * frozen value is never the caller's input. A pass-through inner would return
 * `input` here and freezing it would mutate data the caller still owns, which
 * is why the extractor withholds the flag for every other container.
 */
function buildReadonly(
  ir: SchemaIR & { type: "readonly" },
  input: string,
  g: BuildGen,
): Built | null {
  const built = build(ir.inner, input, g);
  if (built === null || ir.freeze !== true) return built;
  const slot = local(g, "bz");
  return { code: `${built.code}${slot}=Object.freeze(${built.value});`, value: slot };
}

function buildObject(ir: ObjectIR, input: string, g: BuildGen): Built | null {
  if (ir.catchall !== undefined) return null;
  if (ir.stripUnknownKeys !== true && ir.strict !== true) return null;
  // Both swallow an absent key's failure, which a single-pass build that fails
  // at the first bad check cannot model.
  if (ir.skipAbsentKeys !== undefined && ir.skipAbsentKeys.length > 0) return null;
  if (ir.suppressAbsentKeys !== undefined && ir.suppressAbsentKeys.length > 0) return null;
  const nonoptional = new Set(ir.nonoptionalKeys ?? []);
  // Object-level `.refine()` runs on the assembled output (below). superRefine
  // rewrites the payload, which this pass does not model — mutatesBeyondStrip
  // already rejects it, so this is a belt-and-braces narrowing of the type.
  const refines = ir.checks ?? [];
  if (refines.some((check) => check.kind !== "refine_effect")) return null;

  let code = `if(typeof ${input}!=="object"||${input}===null||Array.isArray(${input}))return ${g.fail};`;

  if (ir.strict === true) {
    const keyVar = local(g, "bk");
    code += `for(${keyVar} in ${input}){if(!(${keyMembershipTest(g.ctx, Object.keys(ir.properties), keyVar)}))return ${g.fail};}`;
  }

  const slots: { always: boolean; keyStr: string; value: string }[] = [];
  for (const [key, propIR] of parsedProperties(ir)) {
    const keyStr = escapeString(key);
    const slot = local(g, "bv");
    // A required key has to be present whatever its schema makes of `undefined`.
    if (nonoptional.has(key)) code += `if(!(${keyStr} in ${input}))return ${g.fail};`;
    code += `${slot}=${input}[${keyStr}];`;
    const propBuilt = build(propIR, slot, g);
    if (propBuilt === null) return null;
    code += propBuilt.code;
    slots.push({ always: outputAlwaysDefined(propIR), keyStr, value: propBuilt.value });
  }

  // Same assembly the eager strip walk uses: the longest LEADING run of
  // always-present keys goes into one object literal (V8 stamps it from a
  // cached boilerplate map in a single allocation), and everything after the
  // first conditional key is appended so insertion order still matches zod.
  // The per-key test is zod's own — keep the key when the parsed value is
  // defined, or when it was present on the input at all.
  const out = local(g, "bo");
  const literal: string[] = [];
  let appends = "";
  let leading = true;
  for (const slot of slots) {
    if (leading && slot.always) {
      literal.push(`${slot.keyStr}:${slot.value}`);
      continue;
    }
    leading = false;
    appends += slot.always
      ? `${out}[${slot.keyStr}]=${slot.value};`
      : `if(${slot.value}!==undefined||(${slot.keyStr} in ${input})){${out}[${slot.keyStr}]=${slot.value};}`;
  }
  code += `${out}={${literal.join(",")}};${appends}`;
  // Zod parses the properties into the payload first and skips the check chain
  // when that produced issues, so a bad property suppresses the refine — which
  // this pass gets for free, having already returned FAIL at that property.
  for (const check of refines) {
    code += `if(!${emitEffectCallable(g.ctx, check as RefineEffectCheckIR)}(${out}))return ${g.fail};`;
  }
  return { code, value: out };
}

function buildArray(ir: SchemaIR & { type: "array" }, input: string, g: BuildGen): Built | null {
  // Length checks are pure predicates over `input.length`, so they hoist ahead
  // of the element loop: a size mismatch bails before a single element is
  // validated. Zod reports the per-element issue first when both fail, but the
  // build pass produces no issues — only the sentinel — and the deferred walk
  // that does produce them keeps zod's order.
  let sizes = "";
  const refines: RefineEffectCheckIR[] = [];
  for (const check of ir.checks) {
    switch (check.kind) {
      case "min_length":
        sizes += `if(${input}.length<${check.minimum})return ${g.fail};`;
        break;
      case "max_length":
        sizes += `if(${input}.length>${check.maximum})return ${g.fail};`;
        break;
      case "length_equals":
        sizes += `if(${input}.length!==${check.length})return ${g.fail};`;
        break;
      case "refine_effect":
        refines.push(check);
        break;
      default:
        // super_refine (rewrites the value) or a check kind not modelled here.
        return null;
    }
  }

  const out = local(g, "ba");
  const index = local(g, "bi");
  const elem = local(g, "be");
  const inner = build(ir.element, elem, g);
  if (inner === null) return null;
  let code =
    `if(!Array.isArray(${input}))return ${g.fail};` +
    sizes +
    `${out}=new Array(${input}.length);` +
    `for(${index}=0;${index}<${input}.length;${index}++){` +
    `${elem}=${input}[${index}];${inner.code}${out}[${index}]=${inner.value};}`;
  // `.refine()` sees the parsed payload, which for a rebuilding element is the
  // freshly assembled array — the same value zod hands its checks.
  for (const check of refines) {
    code += `if(!${emitEffectCallable(g.ctx, check)}(${out}))return ${g.fail};`;
  }
  return { code, value: out };
}

function buildTuple(ir: SchemaIR & { type: "tuple" }, input: string, g: BuildGen): Built | null {
  // Trailing-optional and rest handling shape the output length; keep those on
  // the eager walk rather than restating the rules here.
  if (ir.rest !== null) return null;
  if (ir.optStart !== ir.items.length) return null;
  if (ir.items.some((item) => !rejectsUndefined(item))) return null;

  let code = `if(!Array.isArray(${input})||${input}.length!==${ir.items.length})return ${g.fail};`;
  const values: string[] = [];
  for (const [index, itemIR] of ir.items.entries()) {
    const slot = local(g, "bt");
    code += `${slot}=${input}[${index}];`;
    const inner = build(itemIR as SchemaIR, slot, g);
    if (inner === null) return null;
    code += inner.code;
    values.push(inner.value);
  }
  const out = local(g, "bl");
  code += `${out}=[${values.join(",")}];`;
  return { code, value: out };
}

function buildRecord(ir: SchemaIR & { type: "record" }, input: string, g: BuildGen): Built | null {
  const plainStringKey =
    ir.keyType.type === "string" && ir.keyType.checks.length === 0 && ir.keyType.coerce !== true;
  if (!plainStringKey) return null;

  const out = local(g, "br");
  const keyVar = local(g, "brk");
  const valVar = local(g, "brv");
  const inner = build(ir.valueType, valVar, g);
  if (inner === null) return null;
  const hop = emitRuntimeHelper(g.ctx, "__zcHop", ZC_HOP_DECL);
  // `$ZodRecord` gates on `util.isPlainObject`, not the `util.isObject` the
  // object/discriminated-union builds above use — see ZC_PLAIN_DECL. And it
  // skips `__proto__` outright: here that guard is load-bearing twice over,
  // since `out[key]=value` for that key would not add a property at all but
  // REDEFINE the built object's prototype.
  const plain = emitRuntimeHelper(g.ctx, "__zcPlain", ZC_PLAIN_DECL);
  const code =
    `if(!${plain}(${input}))return ${g.fail};` +
    `${out}={};` +
    `for(${keyVar} in ${input}){if(${keyVar}!=="__proto__"&&${hop}.call(${input},${keyVar})){` +
    `${valVar}=${input}[${keyVar}];${inner.code}${out}[${keyVar}]=${inner.value};}}`;
  return { code, value: out };
}

/**
 * `.transform(fn)`: validate the inner schema, then hand its parsed value to the
 * callback. `z.preprocess(fn, schema)` reverses those two steps: call first,
 * then validate the callback's output. Returning FAIL from the inner build
 * preserves the corresponding pipe short-circuit in either direction.
 *
 * The IR reaches here only for a synchronous single-argument callback: a
 * `ctx`-taking or async transform is extracted as a `fallback` instead
 * (see extractPipe), so there is no parse context to reproduce.
 */
function buildEffect(ir: SchemaIR & { type: "effect" }, input: string, g: BuildGen): Built | null {
  if (ir.effectKind === "preprocess") {
    const value = local(g, "bpv");
    const inner = build(ir.inner, value, g);
    if (inner === null) return null;
    return {
      code: `${value}=${emitEffectCallable(g.ctx, ir)}(${input});${inner.code}`,
      value: inner.value,
    };
  }

  const inner = build(ir.inner, input, g);
  if (inner === null) return null;
  const out = local(g, "bx");
  return {
    code: `${inner.code}${out}=${emitEffectCallable(g.ctx, ir)}(${inner.value});`,
    value: out,
  };
}

/**
 * A coercing and/or overwrite string (`z.coerce.string()`, `.trim()`,
 * `.toLowerCase()`, ...): coerce first, then emit checks one statement at a time
 * in DECLARATION order, interleaved with rewrites, because a rewrite is visible
 * to every check after it — `z.string().trim().min(1)` rejects `"  "` where
 * `z.string().min(1).trim()` accepts it. That ordering is exactly why the fast
 * path, which sorts checks cheapest-first and returns the input unchanged, has
 * to decline these.
 *
 * Only reached for a rewriting string; a non-coercing, check-only one never
 * enters the rebuild set and is validated in place by `passthrough`.
 */
function buildString(ir: SchemaIR & { type: "string" }, input: string, g: BuildGen): Built | null {
  const value = local(g, "bs");
  let code =
    ir.coerce === true
      ? `try{${value}=String(${input});}catch(_){return ${g.fail};}`
      : `if(typeof ${input}!=="string")return ${g.fail};${value}=${input};`;
  for (const check of ir.checks) {
    switch (check.kind) {
      case "overwrite_effect":
        code += `${value}=${emitEffectFn(g.ctx, check.source)}(${value});`;
        break;
      case "refine_effect":
        code += `if(!${emitEffectCallable(g.ctx, check)}(${value}))return ${g.fail};`;
        break;
      case "super_refine_effect":
        // Rewrites through zod's payload; mutatesBeyondStrip already rejects it.
        return null;
      default: {
        const expr = fastStringCheck(check, value, g.ctx);
        if (expr === null) return null; // z.url(), unknown format
        code += `if(!(${expr}))return ${g.fail};`;
      }
    }
  }
  return { code, value };
}

/**
 * `z.stringbool()`: normalize once, select the declared truthy/falsy side, and
 * return the boolean directly. The ordinary Fast Path cannot host this codec
 * because its contract returns the original input by reference; the build path
 * is designed for exactly this kind of small output rewrite.
 */
function buildStringBool(ir: StringBoolIR, input: string, g: BuildGen): Built {
  let code = `if(typeof ${input}!=="string")return ${g.fail};`;
  let normalized = input;
  if (!ir.caseSensitive) {
    normalized = local(g, "bn");
    code += `${normalized}=${input}.toLowerCase();`;
  }

  const out = local(g, "bb");
  if (stringBoolUsesInline(ir)) {
    const membership = (values: readonly string[]): string =>
      values.map((value) => `${normalized}===${escapeString(value)}`).join("||");
    code +=
      `if(${membership(ir.truthy)}){${out}=true;}` +
      `else if(${membership(ir.falsy)}){${out}=false;}` +
      `else{return ${g.fail};}`;
  } else {
    const lookup = emitStringBoolMap(ir, g.ctx);
    code += `${out}=${lookup}.get(${normalized});if(${out}===undefined)return ${g.fail};`;
  }
  return { code, value: out };
}

/** Primitive nodes whose `coerce` flag rewrites their output before checks run. */
type CoercedPrimitiveIR = Extract<SchemaIR, { type: "number" | "boolean" | "bigint" | "date" }>;

/**
 * Coerce once into a local, then reuse the ordinary Fast Path as the acceptance
 * predicate over the converted value. The build path only needs a verdict on
 * its hot pass; if it fails, the existing deferred slow walk reruns the original
 * coercing schema and produces Zod-identical issues.
 *
 * Number/BigInt/Date conversion can invoke user hooks and throw. Zod catches
 * those throws and reports invalid_type, so the sentinel branch does the same
 * without allocating an issue. Boolean never invokes conversion hooks.
 */
function buildCoercedPrimitive(ir: CoercedPrimitiveIR, input: string, g: BuildGen): Built | null {
  if (ir.coerce !== true) return null;
  const value = local(g, "bc");
  let conversion: string;
  switch (ir.type) {
    case "number":
      conversion = `Number(${input})`;
      break;
    case "boolean":
      conversion = `Boolean(${input})`;
      break;
    case "bigint":
      conversion = `BigInt(${input})`;
      break;
    case "date":
      conversion = `new Date(${input})`;
      break;
  }

  // A fresh shallow node is intentional: only the coerce flag changes. The
  // existing primitive generator remains the single source of truth for every
  // range, format, refine and finite/valid-date check.
  const predicate = generateFast(
    { ...ir, coerce: false },
    createFastGen(value, g.ctx, true, g.scope),
  );
  if (predicate === null) return null;

  const assign = `${value}=${conversion};`;
  const code = ir.type === "boolean" ? assign : `try{${assign}}catch(_){return ${g.fail};}`;
  return {
    code: code + (predicate === "true" ? "" : `if(!(${predicate}))return ${g.fail};`),
    value,
  };
}

/**
 * `.default(v)`: `undefined` yields the declared value without running the
 * inner schema, anything else parses normally — the same two branches
 * `slowDefault` emits, reading the value off the retained schema so a
 * reference-typed default keeps zod's identity (one shared object, not a copy).
 *
 * The substituted value is not validated, so it makes the fast path a PARTIAL
 * predicate (`fc(undefined)` is false where the schema accepts) — which is why
 * this records {@link CodeGenContext.buildSubstitutesValue}, on which
 * `generateValidator` withholds `.is()`.
 */
function buildDefault(
  ir: SchemaIR & { type: "default" },
  input: string,
  g: BuildGen,
): Built | null {
  const inner = build(ir.inner, input, g);
  if (inner === null) return null;
  // Every `default` node is in the rebuild set, so it is always BUILT and never
  // passed through — which makes this flag an exact record of whether the
  // finished pass substitutes a value.
  g.ctx.buildSubstitutesValue = true;
  const out = local(g, "bq");
  const value = defaultValueExpr(ir);
  // Zod re-applies the default when the inner returns undefined for a defined
  // input; only emitted when the inner can actually do that.
  const reapply = needsPostInnerDefault(ir) ? `if(${out}===undefined){${out}=${value};}` : "";
  return {
    code:
      `if(${input}===undefined){${out}=${value};}` +
      `else{${inner.code}${out}=${inner.value};${reapply}}`,
    value: out,
  };
}

/** `optional` / `nullable` around a rebuilding inner: pass the sentinel through. */
function buildSentinel(
  innerIR: SchemaIR,
  input: string,
  g: BuildGen,
  test: string,
  sentinel: string,
): Built | null {
  const inner = build(innerIR, input, g);
  if (inner === null) return null;
  const out = local(g, "bw");
  return {
    code: `if(${input}${test}){${out}=${sentinel};}else{${inner.code}${out}=${inner.value};}`,
    value: out,
  };
}

/** Allocate a `var` the hosted build function declares. */
function local(g: BuildGen, prefix: string): string {
  const name = emitTemp(g.ctx, prefix);
  g.scope.temps.push(name);
  return name;
}
