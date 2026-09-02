/**
 * Issue factory function bodies (statement form).
 *
 * These functions produce the same `{code, ...}` shapes that lean-mode
 * generated code would otherwise inline at every check site.
 * Hosted in "virtual:zod-compiler/runtime" and called as `__zcTS(...)` etc.
 *
 * Argument convention (positional, kept short to minimize call-site bytes):
 *   __zcTS(minimum, origin, inclusive, input, path, msg?)  — too_small
 *   __zcTSt(minimum, origin, input, path, msg?)            — too_small, tuple key order
 *   __zcTBt(maximum, origin, input, path, msg?)            — too_big, tuple key order
 *   __zcTB(maximum, origin, inclusive, input, path, msg?)  — too_big
 *   __zcIT(expected, input, path, msg?)                    — invalid_type
 *   __zcITc(expected, input, path, msg?)                   — invalid_type, `code` first
 *   __zcIF(origin, format, input, path, extra?, msg?)      — invalid_format (extra merged into result)
 *   __zcIV(values, input, path, extra?, msg?)              — invalid_value (extra merged into result)
 *   __zcUK(keys, input, path, msg?)                        — unrecognized_keys
 *
 * The trailing msg argument carries a static custom error message; when
 * absent, the __zcFin finalizer applies the configured locale default.
 *
 * KEY ORDER IS PART OF THE CONTRACT. `ZodError.message` is
 * `JSON.stringify(issues, …, 2)`, so the order these factories insert keys in is
 * printed verbatim in the message every consumer logs, snapshots or serializes.
 * Each literal below therefore reproduces the order of the corresponding
 * `payload.issues.push({…})` in zod, which is irregular by type — `too_small`
 * from a check leads with `origin` while the same code from a tuple's length
 * branch leads with `code` — and every factory writes `message` LAST, because
 * zod's `finalizeIssue` assigns it after the fact (`full.message = …`) even for
 * a custom message baked into the check's error map.
 */

const ZC_TS_DECL =
  'function __zcTS(m,o,i,inp,p,msg){var r={origin:o,code:"too_small",minimum:m,inclusive:i,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

/**
 * too_small in the TUPLE under-length key order. $ZodTuple pushes
 * `{ code, minimum, inclusive: true, input, inst, origin }`, so its `origin`
 * trails `inclusive` where every check-created size issue leads with it. Its
 * over-length sibling is __zcTBt.
 */
const ZC_TS_TUPLE_DECL =
  'function __zcTSt(m,o,inp,p,msg){var r={code:"too_small",minimum:m,inclusive:true,origin:o,input:inp,path:p,continue:false};if(msg!==undefined)r.message=msg;return r;}';

const ZC_TS_EXACT_DECL =
  'function __zcTSx(m,o,inp,p,msg){var r={origin:o,code:"too_small",minimum:m,inclusive:true,exact:true,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

const ZC_TB_DECL =
  'function __zcTB(m,o,i,inp,p,msg){var r={origin:o,code:"too_big",maximum:m,inclusive:i,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

/**
 * too_big in the TUPLE over-length key order. $ZodTuple spreads
 * `{ code, maximum, inclusive }` and appends `origin` after `input`/`inst`, so
 * its `origin` trails `inclusive` where every check-created size issue leads
 * with it. Its under-length sibling is __zcTSt.
 */
const ZC_TB_TUPLE_DECL =
  'function __zcTBt(m,o,inp,p,msg){var r={code:"too_big",maximum:m,inclusive:true,origin:o,input:inp,path:p,continue:false};if(msg!==undefined)r.message=msg;return r;}';

const ZC_TB_EXACT_DECL =
  'function __zcTBx(m,o,inp,p,msg){var r={origin:o,code:"too_big",maximum:m,inclusive:true,exact:true,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

const ZC_IT_DECL =
  'function __zcIT(e,inp,p,msg){var r={expected:e,code:"invalid_type",input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

/**
 * invalid_type with `code` ahead of `expected`. Every schema in zod spells this
 * issue `{ expected, code }` — except `$ZodDiscriminatedUnion`, whose
 * non-object guard writes `{ code, expected }`. One literal, one key order, and
 * it shows up in `ZodError.message`.
 */
const ZC_IT_CODE_FIRST_DECL =
  'function __zcITc(e,inp,p,msg){var r={code:"invalid_type",expected:e,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

/**
 * `o` is the leading `origin`, present only for the formats whose issue carries
 * one: `$ZodCheckStringFormat`'s default pattern check and the regex /
 * includes / starts_with / ends_with checks all lead with `origin: "string"`,
 * while `z.url()`'s own pushes and every `$ZodCustomStringFormat` omit it
 * entirely. `extra` holds the per-format tail (`pattern`, `includes`, `prefix`,
 * `suffix`, `note`) and is merged BEFORE input/path so it lands where zod
 * writes it.
 */
const ZC_IF_DECL =
  'function __zcIF(o,f,inp,p,extra,msg){var r=o===undefined?{code:"invalid_format",format:f}:{origin:o,code:"invalid_format",format:f};if(extra)Object.assign(r,extra);r.input=inp;r.path=p;if(msg!==undefined)r.message=msg;return r;}';

/**
 * `extra` carries the per-producer fields: enum and literal push `values` only,
 * while z.stringbool()'s codec transform also pushes `expected: "stringbool"`.
 * Merged the same way __zcIF merges its own.
 */
const ZC_IV_DECL =
  'function __zcIV(values,inp,p,extra,msg){var r={code:"invalid_value"};if(extra)Object.assign(r,extra);r.values=values;r.input=inp;r.path=p;if(msg!==undefined)r.message=msg;return r;}';

const ZC_UK_DECL =
  'function __zcUK(k,inp,p,msg){var r={code:"unrecognized_keys",keys:k,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

/** All issue factory declarations indexed by helper name. */
export const ISSUE_DECLS: Readonly<Record<string, string>> = {
  __zcTS: ZC_TS_DECL,
  __zcTSt: ZC_TS_TUPLE_DECL,
  __zcTSx: ZC_TS_EXACT_DECL,
  __zcTB: ZC_TB_DECL,
  __zcTBt: ZC_TB_TUPLE_DECL,
  __zcTBx: ZC_TB_EXACT_DECL,
  __zcIT: ZC_IT_DECL,
  __zcITc: ZC_IT_CODE_FIRST_DECL,
  __zcIF: ZC_IF_DECL,
  __zcIV: ZC_IV_DECL,
  __zcUK: ZC_UK_DECL,
};

/**
 * Float-safe remainder — byte-for-byte port of zod's util.floatSafeRemainder.
 * Raw `%` mis-rejects valid multiples of decimal steps (0.3 % 0.1 !== 0).
 *
 * zod 4.5 REPLACED the decimal-scaling implementation this once mirrored with a
 * ratio-and-tolerance one, and the two disagree in both directions: the old form
 * accepted `1e-7` as a multiple of 3 (its `toFixed` scaling collapsed the value
 * to 0) and rejected `1e21` (where `toFixed` yields exponential notation and
 * `parseInt` then reads 1). The tolerance is 4x epsilon because `val` and `step`
 * each round to a double before the division rounds again, so a true decimal
 * multiple's quotient can sit up to 1.5 scaled epsilons from the integer.
 */
export const ZC_FSR_DECL =
  "function __zcFsr(v,s){var r=v/s;var q=Math.round(r);" +
  "var t=4*Number.EPSILON*Math.max(Math.abs(r),1);" +
  "return Math.abs(r-q)<t?0:r-q;}";

/**
 * Hoisted `Object.prototype.hasOwnProperty` reference. Record fast/slow paths
 * iterate keys with `for(k in o)` (no `Object.keys` array allocation) and guard
 * each key with `__zcHop.call(o,k)` to skip inherited enumerable properties —
 * yielding the exact own-enumerable string-key set `Object.keys` would, so
 * fast/slow stay in agreement and parity with zod's own-key record semantics is
 * preserved. The hoisted reference inlines in V8; reading the prototype property
 * per call would not.
 */
export const ZC_HOP_DECL = "const __zcHop=Object.prototype.hasOwnProperty;";

/**
 * Port of zod's `util.isPlainObject` — the guard `$ZodRecord` applies to its
 * input, and a STRICTLY narrower test than the `util.isObject` (`typeof
 * "object"`, not null, not an array) that `$ZodObject` uses.
 *
 * The distinction is load-bearing and was a validation hole while records shared
 * the object guard: `z.record(z.string(), z.string())` accepted a `Date`, a
 * `Map`, a `RegExp`, an `Error`, a `File` and any class instance — every one of
 * which zod rejects with `invalid_type`/`expected: "record"`, and none of which
 * has own enumerable string keys for the value schema to catch. Compiled output
 * therefore said "valid" to inputs zod refuses, which is the one direction a
 * validator must never diverge in.
 *
 * The algorithm is zod's, step for step, because the answer is observable and
 * the edge cases are deliberate:
 *   - `constructor === undefined` (a null-prototype object) is PLAIN;
 *   - a non-function own `constructor` (`{ constructor: 1 }`) is PLAIN;
 *   - otherwise the constructor's `prototype` must be an object carrying its OWN
 *     `isPrototypeOf` — which `Object.prototype` does and `Date.prototype`,
 *     `Map.prototype` and every user class prototype do not. Testing that rather
 *     than `Object.getPrototypeOf(o) === Object.prototype` is what lets a plain
 *     object from another realm (a vm context, an iframe) still count as plain.
 *
 * `c===Object` is a short-cut, not a fourth rule: it is exactly the case where
 * zod's remaining steps are foregone — `Object.prototype` is an object and has
 * its own `isPrototypeOf` — so the answer is `true` either way. It is also the
 * case every ordinary record takes (an object literal, `JSON.parse` output, a
 * `Map`-free DTO), and taking it saves the `prototype` load and the
 * `hasOwnProperty` call: measured 9.6 → 5.7 ns on a monomorphic record and
 * 15.7 → 9.2 ns across 16 shapes, i.e. 22% of a five-key record's whole parse.
 * A plain object from another realm has a different `Object` and simply takes
 * the long road to the same verdict, as before.
 *
 * Self-contained (`Object.prototype.hasOwnProperty` spelled out rather than
 * reusing `__zcHop`) so inline mode can emit this decl alone: `emitRuntimeHelper`
 * pushes only the decl it is asked for, and a helper that closed over another
 * name would dangle wherever that one was not also emitted.
 */
export const ZC_PLAIN_DECL =
  'function __zcPlain(o){if(typeof o!=="object"||o===null||Array.isArray(o))return false;' +
  'var c=o.constructor;if(c===Object||c===undefined||typeof c!=="function")return true;' +
  'var p=c.prototype;if(typeof p!=="object"||p===null||Array.isArray(p))return false;' +
  'return Object.prototype.hasOwnProperty.call(p,"isPrototypeOf");}';

/**
 * `z.email()`'s default validator, `regexes.email`, as a single linear scan.
 *
 * Zod's pattern is
 * `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`,
 * and even its lookahead-free rewrite (EMAIL_FAST_REGEX_SOURCE) backtracks at
 * every dot it fails to find: `(?:[X]+\.)*` re-tries the run one character
 * shorter each time, and the domain's `(?:label\.)+` does the same over the
 * TLD. Written as a scanner the language is:
 *
 *   local  — `[A-Za-z0-9_'+.-]+`, no leading `.`, no `..`, and the character
 *            before `@` is neither `.` nor `'` (that last is the `[A-Za-z0-9_+-]`
 *            the pattern demands there);
 *   domain — one or more labels `[A-Za-z0-9][A-Za-z0-9-]*` each ending in `.`,
 *            then a TLD of two or more letters running to the end.
 *
 * A trailing `\n` is not accepted: the pattern has no `m` flag, so its `$`
 * matches only at the end of input, and the scan reads to `length`.
 *
 * Measured against the fast regex on V8: 32 → 16 ns for `alice@example.com`,
 * 48 → 40 for `bob_smith-99@mail-server.io`, 39 → 20 for a non-address, and a
 * tie from ~35 characters up (the regex's per-character work is cheaper than a
 * `charCodeAt` loop's; its fixed dispatch cost is what the scanner avoids). A
 * lookbehind rewrite runs about as fast but needs ES2018 regex support, which
 * the CLI's React Native / Hermes and older-Safari consumers cannot assume.
 *
 * Equivalence to zod's regex — every string, both verdicts — is pinned by
 * tests/core/codegen/email-scanner.test.ts. Reached only behind a `typeof`
 * string guard, like the `.test()` it replaces; issue sites keep reporting
 * zod's own pattern string (see `emitRegexSourceString`).
 */
export const ZC_EMAIL_DECL =
  "function __zcEmail(s){var n=s.length,i=0,c,p=46;" +
  // Local part. `p` starts as `.` so a leading dot trips the `..` rule.
  "for(;;){if(i===n)return false;c=s.charCodeAt(i);if(c===64)break;" +
  "if(c===46){if(p===46)return false;}" +
  "else if(!((c>=97&&c<=122)||(c>=65&&c<=90)||(c>=48&&c<=57)||c===95||c===39||c===43||c===45))return false;" +
  "p=c;i++;}" +
  "if(p===46||p===39)return false;" +
  // Domain. `l` is the current label's start, `t` whether it is letters-only.
  "var l=++i,d=0,t=true;" +
  "for(;i<n;i++){c=s.charCodeAt(i);" +
  "if((c>=97&&c<=122)||(c>=65&&c<=90))continue;" +
  "if(c===46){if(i===l)return false;d++;l=i+1;t=true;continue;}" +
  "if((c>=48&&c<=57)||c===45){if(c===45&&i===l)return false;t=false;continue;}" +
  "return false;}" +
  "return d>0&&t&&n-l>=2;}";

/**
 * Ports of `util.getLengthableOrigin` / `util.getSizableOrigin` — the `origin` a
 * length/size check puts on its issue, computed from the RUNTIME INPUT rather
 * than from the schema.
 *
 * They only matter because those checks declare a `when` predicate
 * (`!nullish(value) && value.length/size !== undefined`), which bypasses zod's
 * abort gate: `z.string().min(2)` handed `[]` reports the `invalid_type` AND a
 * `too_small` whose origin is `"array"`, because the empty array satisfies the
 * `when`. Inside the matching type branch the origin is statically known and
 * these are not used; they exist for the type-MISMATCH branch, where the input
 * can be anything with a `.length` or a `.size`.
 *
 * `File` is probed through `typeof` first: zod tests `input instanceof File`
 * unguarded, which throws where the global is absent — an environment zod does
 * not run in, and not one worth reproducing a crash for.
 */
export const ZC_LENGTH_ORIGIN_DECL =
  'function __zcLo(v){return Array.isArray(v)?"array":typeof v==="string"?"string":"unknown";}';

/**
 * Drop an own `__proto__` from a container the parse hands back BY REFERENCE.
 *
 * zod never lets the key into an output: `$ZodObject`'s shape loop strips a
 * declared one, `handleCatchall` skips an undeclared one, and `$ZodRecord` skips
 * it while copying — all so the assignment into their fresh `{}` cannot replace
 * the result's prototype. A compiled loose/catchall object or record IS its
 * input, so the key has to be removed here instead; leaving it made
 * `Object.assign({}, parsed)` a prototype-pollution sink, since [[Set]] runs the
 * inherited setter the spread that built the value did not.
 *
 * Copies rather than editing in place: the divergence note promises the caller
 * its own container back, not one with a key silently deleted from it. The
 * common object has no such key and is returned untouched, so the cost is one
 * `hasOwnProperty` call.
 */
export const ZC_PROTO_SCRUB_DECL =
  'function __zcPs(o){if(!Object.prototype.hasOwnProperty.call(o,"__proto__"))return o;' +
  'var c={...o};delete c["__proto__"];return c;}';

/**
 * Code points in a string — zod's `util.codePointLength`, verbatim. A surrogate
 * pair counts once and a lone surrogate as itself. The regex probe is the fast
 * exit for a string with no astral characters, and the hand-rolled loop avoids
 * the allocating string iterator. Only reached from a length check whose
 * UTF-16 count leaves the verdict in doubt (see stringLengthTests).
 */
export const ZC_CPL_DECL =
  "function __zcCpl(s){var n=s.length;if(!/[\\uD800-\\uDBFF]/.test(s))return n;var c=n;for(var i=0;i<n-1;i++){if((s.charCodeAt(i)&0xfc00)===0xd800&&(s.charCodeAt(i+1)&0xfc00)===0xdc00){c--;i++;}}return c;}";

export const ZC_SIZE_ORIGIN_DECL =
  'function __zcSo(v){return v instanceof Set?"set":v instanceof Map?"map":' +
  '(typeof File!=="undefined"&&v instanceof File)?"file":"unknown";}';

/**
 * Issue codes zod raises from a schema's `_zod.parse` rather than from a check,
 * and which therefore carry `continue !== true` — what `util.aborted` looks for.
 *
 * Everything a CHECK produces (`too_small`, `too_big`, `invalid_format`,
 * `not_multiple_of`, a refine's `custom`) is continuable, because `$ZodCheck`
 * sets `continue: !def.abort` and an `abort: true` check costs the schema its
 * compiled path anyway — so classifying by code alone is exact for generated
 * issues.
 *
 * `unrecognized_keys` is the one parse-level issue zod pushes WITH
 * `continue: true`: it describes the shape of the input rather than the
 * validity of the parsed value, so the parse still fails but the object's own
 * refines run first and a union does not count the option as aborted.
 *
 * Read by {@link ZC_AB_DECL} and by the union's option-pruning loop, which
 * applies the same rule inline over a per-option issue array.
 */
const ABORTING_ISSUE_CODES: readonly string[] = [
  "invalid_type",
  "invalid_value",
  "invalid_union",
  "invalid_key",
  "invalid_element",
];

/** `c==="invalid_type"||c==="invalid_value"||…` over the code held in `codeExpr`. */
export function abortingCodeTest(codeExpr: string): string {
  return ABORTING_ISSUE_CODES.map((code) => `${codeExpr}===${JSON.stringify(code)}`).join("||");
}

/**
 * Port of zod's `util.aborted(payload, startIndex)`: has anything since
 * `startIndex` produced a NON-continuable issue?
 *
 * zod gates a schema's check chain on this (`runChecks`: `else if (isAborted)
 * continue`), which is what makes a container's `.refine()` still run after a
 * property or element failed its own `min`/`max`/format check, and stop running
 * once one failed to parse at all. The `startIndex` is the issue count when the
 * node was entered, mirroring the fresh payload zod hands each sub-schema.
 *
 * Size/length checks are exempt in zod — they declare a `when` predicate, which
 * bypasses the abort gate — so generated code leaves those ungated and only
 * wraps the refine/superRefine effects.
 */
export const ZC_AB_DECL = `function __zcAb(e,i){for(;i<e.length;i++){var s=e[i];if(s.continue===false)return true;var c=s.code;if(${abortingCodeTest("c")})return true;}return false;}`;

/**
 * Port of zod's `util.finalizeIssue` for issues NESTED inside an
 * `invalid_key` / `invalid_element` wrapper. Those never reach the top-level
 * finalization loop (which walks only the outer array), so zod finalizes them
 * where it builds the wrapper: locale message applied when none was baked in,
 * `input` cleared. Their `path` stays RELATIVE to the key or value schema — zod
 * ran it on a fresh payload — so nothing rewrites it.
 *
 * `input` is `delete`d rather than assigned `undefined`, matching zod's own
 * `delete full.input` and the top-level finalizer: the key's PRESENCE is
 * observable (`"input" in issue`, `Object.keys`, spread, a strict deep-equal
 * against a zod issue), so assigning left a nested issue one key wider than
 * zod's. Only reached while an error is being built — never on a successful
 * parse — so the dictionary-mode transition it costs is confined to the path
 * that then constructs a ZodError anyway.
 */
export const ZC_FZ_DECL =
  "function __zcFz(e){for(var i=0;i<e.length;i++){var s=e[i];" +
  'if(s.message===undefined&&typeof __zcMsg==="function")s.message=__zcMsg(s);' +
  "delete s.input;delete s.continue;}return e;}";

/**
 * Port of zod's `util.prefixIssues(key, issues)` for a map entry whose key is a
 * property-key type: each issue's RELATIVE path is spliced onto the map's own
 * path plus the key, and the issue moves into the parent's array.
 *
 * `b.concat(k,x.path)` flattens `x.path` one level, giving exactly
 * `[...base, key, ...relative]`.
 */
export const ZC_PFX_DECL =
  "function __zcPfx(d,s,b,k){for(var i=0;i<s.length;i++){var x=s[i];x.path=b.concat(k,x.path);d.push(x);}}";

/** Does `keyExpr` hold one of zod's `util.propertyKeyTypes` (string|number|symbol)? */
export function propertyKeyTest(keyExpr: string): string {
  return `typeof ${keyExpr}==="string"||typeof ${keyExpr}==="number"||typeof ${keyExpr}==="symbol"`;
}

/**
 * superRefine fast-check: run the payload callback on a throwaway payload and
 * report whether it both added nothing AND left the value alone. zod's own
 * wrapper (the referenced function) installs `addIssue` and normalizes what the
 * user adds, so the verdict is zod's; the issues themselves are re-collected by
 * the slow walk.
 *
 * The `p.value===v` half is what lets a superRefine node keep a fast path at
 * all. `value` is writable public API ($RefinementCtx extends ParsePayload), so
 * a callback may rewrite it, and the fast path's caller returns the ORIGINAL
 * input on success — which would then be stale. Reporting false when the value
 * moved routes those parses into the slow walk, which propagates the new value
 * (see ZC_SR_DECL). Callbacks that only validate — effectively all of them —
 * still take the fast exit.
 */
export const ZC_SR_OK_DECL =
  "function __zcSrOk(f,v){var p={value:v,issues:[]};__zcSrRun(f,p);" +
  "return p.issues.length===0&&p.value===v;}";

/**
 * Module-local (never imported by generated code) — __zcSr/__zcSrOk call it.
 * Lean mode declares it in the runtime module beside them; inline mode pushes it
 * into the preamble alongside whichever of the two is used.
 *
 * Invoke the referenced wrapper, reproducing zod's synchronous-parse contract:
 * a callback that returns a promise makes zod raise $ZodAsyncError rather than
 * silently accepting. Because the ref points at zod's superRefine WRAPPER, not
 * the user's function, an async callback cannot be detected while extracting —
 * the returned thenable is the only evidence, so the test lives here. Sync
 * callbacks return undefined, so the guard short-circuits on the first operand.
 */
export const ZC_SR_RUN_DECL =
  "function __zcSrRun(f,p){var r=f(p);" +
  'if(r&&typeof r.then==="function"){throw new __zcCore.$ZodAsyncError();}}';

/**
 * z.custom()/z.instanceof() fast verdict. Zod treats truthy predicate returns
 * as success and raises $ZodAsyncError when a synchronous parse encounters a
 * thenable, including a non-async function that happens to return a Promise.
 */
export const ZC_CUSTOM_OK_DECL =
  "function __zcCu(f,v){var r=f(v);" +
  'if(r&&typeof r.then==="function"){throw new __zcCore.$ZodAsyncError();}return !!r;}';

/**
 * Raise zod's synchronous-parse error. A user callback that hands back a
 * Promise — a `.refine()` predicate, a `.transform()`, a `z.preprocess()` —
 * makes zod's sync `safeParse` throw `$ZodAsyncError` rather than treat the
 * Promise as a value (a truthy one, for a predicate, which would ACCEPT the
 * input). The callback's source cannot tell: only an `async` function is
 * detectable at extraction time (those are delegated), and a plain function
 * that returns a Promise looks like any other. So the test is on the returned
 * value, at every call site that consumes one, with zod's own
 * `instanceof Promise` — a non-Promise thenable is a plain value to zod too.
 *
 * Hosted rather than inlined so the throw stays out of the hot path's inlining
 * budget: call sites test `x instanceof Promise` themselves and branch here
 * only in the exotic case. The compiled `parseAsync`/`safeParseAsync` wrappers
 * catch this and re-run through zod's async pipeline (see MK_VALIDATOR_DECL),
 * so an async-capable caller still gets zod's answer.
 *
 * `.catch()`, `.default()` and `.overwrite()` callbacks are deliberately NOT
 * guarded: zod substitutes whatever they return, Promise included.
 */
export const ZC_ASYNC_DECL = "function __zcAsy(){throw new __zcCore.$ZodAsyncError();}";

/**
 * Run a retained zod schema for a delegated sub-schema and return its RAW
 * payload — `_zod.run` on a fresh `{value, issues: []}`, the exact call zod's
 * own `safeParse` makes — rather than the finalized `SafeParseResult`.
 *
 * The raw payload is the only place zod's abort state survives.
 * `finalizeIssue` deletes `continue` from every issue and `safeParse` builds
 * its ZodError from the finalized copies, so a delegate that went through
 * `safeParse` could not tell a `z.custom()` failure (`continue: false` — zod
 * defaults `z.custom()` to `abort: true`) from a `.refine()` one
 * (`continue: true`). A plain union prunes its options on that flag
 * (`util.aborted`): with it lost, an option failing through a delegated
 * aborting check was surfaced as the sole non-aborted option instead of inside
 * `invalid_union`. Reading the payload keeps the flag until __zcRf copies it
 * onto the finalized issue, where the union's pruning loop reads it and the
 * top-level finalizer then deletes it, as zod's does.
 *
 * `_zod.run` is also immune to the aliasing hazard `__rfp_N` guards against:
 * `__zcMkv` installs the compiled methods as own `parse`/`safeParse` slots and
 * never touches `_zod`, so a retained entry that IS the compiled schema still
 * runs zod's implementation here. A Promise result is zod's `$ZodAsyncError`,
 * as in `_safeParse`.
 */
export const ZC_RUN_DELEGATE_DECL =
  "function __zcRd(z,v,c){var r=z.run({value:v,issues:[]},c);" +
  "if(r instanceof Promise)throw new __zcCore.$ZodAsyncError();return r;}";

/**
 * Finalize a delegate's raw issues onto the validator's list. Each goes
 * through zod's own `util.finalizeIssue` — the check's and schema's error
 * maps, the per-call ctx, `customError`, the locale, then "Invalid input", with
 * `inst` and `input` stripped — which is the very function `safeParse` maps
 * every issue through, so the messages are zod's byte for byte. The node's
 * path is prefixed onto the issue's relative one as zod's `prefixIssues`
 * would, and the abort marker is re-applied: an issue whose raw `continue` was
 * not `true` aborted in zod's sense (`util.aborted`), which the union pruning
 * loop reads as `continue:false` before the top-level finalizer deletes the
 * key again (see ZC_RUN_DELEGATE_DECL).
 */
export const ZC_DELEGATE_ISSUES_DECL =
  "function __zcRf(s,c,e,p){var g=__zcCore.config();for(var i=0;i<s.length;i++){" +
  "var q=s[i],f=__zcCore.util.finalizeIssue(q,c,g);f.path=p.concat(f.path);" +
  "if(q.continue!==true)f.continue=false;e.push(f);}}";

/**
 * superRefine slow-path merge: run the callback, then move its issues onto the
 * validator's list the way zod's finalizeIssue does — the node's path prefixed
 * onto any path the user supplied, the internal `inst`/`continue` fields
 * dropped (they are zod bookkeeping, deleted before the issue is user-visible),
 * and the owning schema's static message `m` applied to an issue that carries
 * none of its own, since zod stamps the owner onto every issue a check raises.
 *
 * Returns the payload, so the caller can write `.value` back (the callback may
 * have rewritten it) and read `.aborted`. Aborted is set when any issue aborts
 * in zod's sense (`continue !== true`, which covers `fatal: true` and the string
 * shorthand, whose issue carries no `continue` at all) — or when the callback
 * set it directly, also public payload API. A union option at whose root the
 * superRefine sits reads the flag to mark itself aborted, matching how zod
 * prunes option errors. The aborting issue ALSO keeps a `continue:false`
 * marker of its own, because zod's `util.aborted` reads the flag off the
 * issues and those travel up through containers where the payload flag does
 * not: a fatal superRefine on an object's property aborts the union option
 * holding the object. The top-level finalizer deletes the marker, as zod's
 * `finalizeIssue` does, so no user-visible issue carries it.
 */
export const ZC_SR_DECL =
  "function __zcSr(f,v,p,e,m){var q={value:v,issues:[]};__zcSrRun(f,q);" +
  "for(var i=0;i<q.issues.length;i++){var s=q.issues[i],t={};" +
  'for(var k in s){if(k!=="inst"&&k!=="continue")t[k]=s[k];}' +
  "if(s.continue!==true){q.aborted=true;t.continue=false;}" +
  "t.path=s.path&&s.path.length?p.concat(s.path):p;" +
  "if(t.message===undefined&&m!==undefined)t.message=m;e.push(t);}return q;}";

/** Non-issue runtime helper declarations hosted in the virtual module. */
export const RUNTIME_HELPER_DECLS: Readonly<Record<string, string>> = {
  __zcAb: ZC_AB_DECL,
  __zcFsr: ZC_FSR_DECL,
  __zcFz: ZC_FZ_DECL,
  __zcHop: ZC_HOP_DECL,
  __zcLo: ZC_LENGTH_ORIGIN_DECL,
  __zcSo: ZC_SIZE_ORIGIN_DECL,
  __zcCpl: ZC_CPL_DECL,
  __zcEmail: ZC_EMAIL_DECL,
  __zcPs: ZC_PROTO_SCRUB_DECL,
  __zcPlain: ZC_PLAIN_DECL,
  __zcPfx: ZC_PFX_DECL,
  __zcCu: ZC_CUSTOM_OK_DECL,
  __zcSr: ZC_SR_DECL,
  __zcSrOk: ZC_SR_OK_DECL,
  __zcAsy: ZC_ASYNC_DECL,
  __zcRd: ZC_RUN_DELEGATE_DECL,
  __zcRf: ZC_DELEGATE_ISSUES_DECL,
};
