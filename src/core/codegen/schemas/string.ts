import type { CheckIR, CheckStringFormat, StringIR } from "../../types.js";
import type { CodeGenContext, FastGen, SlowGen } from "../context.js";
import {
  checkPriority,
  emitEffectCallable,
  emitEffectFn,
  emitRegex,
  emitRegexSourceString,
  emitRuntimeHelper,
  escapeString,
} from "../context.js";
import { emit } from "../emit.js";
import { invalidFormat, invalidType, tooBig, tooSmall } from "../emit-issue.js";
import { ZC_EMAIL_DECL } from "../issue-decls.js";
import {
  EMAIL_REGEX_SOURCE,
  fastTestSource,
  isDefaultEmailPattern,
  UUID_REGEX_SOURCE,
} from "../well-known-regex.js";
import { refineCheck, superRefineCheck, superRefineFastTest } from "./effect.js";
import { stringLengthTests, whenGatedSizeChecks } from "./sizeable.js";

/** `re.lastIndex=0;` reset statement for stateful (g/y-flagged) regexes. */
function lastIndexReset(regexVar: string, flags: string | undefined): string {
  return flags && /[gy]/.test(flags) ? `${regexVar}.lastIndex=0;` : "";
}

/**
 * `regexes.httpProtocol.source`. `parseURLObject` compares a url check's
 * protocol SOURCE against it — not the schema constructor — so any check whose
 * protocol is spelled this way gets the guard, `z.httpUrl()` or not.
 */
const HTTP_PROTOCOL_SOURCE = "^https?$";

/**
 * Generate the url check, mirroring $ZodURL semantics:
 * trim → (for an http(s)-protocol check without normalize) require `://` →
 * new URL(trimmed) → optional hostname/protocol regex tests → write back
 * url.href (normalize) or the trimmed input with its tabs and newlines deleted.
 *
 * The `://` guard is `parseURLObject`'s: without it the URL parser accepts
 * `http:example.com`, and its rejection is a distinct issue (`note: "Invalid
 * URL format"`, no `pattern`) pushed BEFORE the parser runs. The deletion of
 * `\t`, `\n` and `\r` (`stripTabAndNewline`) matches what the parser itself
 * drops before it reads the host, so the returned value names the host that was
 * validated.
 *
 * $ZodURL is another constructor that OVERRIDES the `??=`-installed default
 * check, so none of the issues below carries `origin` — and the two that do
 * carry a `pattern` use `regex.source`, not the default check's
 * `regex.toString()` (no delimiters, no flags). Both are reproduced verbatim.
 */
function slowUrlCheck(check: CheckStringFormat, g: SlowGen): string {
  const trimmedVar = g.temp("ut");
  const urlVar = g.temp("u");
  let inner = "";
  if (check.hostname) {
    const re = g.regex("host", check.hostname, check.hostnameFlags);
    inner += emit`
      ${lastIndexReset(re, check.hostnameFlags)}
      if(!${re}.test(${urlVar}.hostname)){
        ${invalidFormat(g, "url", {
          extra: `note:"Invalid hostname",pattern:${escapeString(check.hostname)}`,
          message: check.message,
        })}
      }`;
  }
  if (check.protocol) {
    const re = g.regex("proto", check.protocol, check.protocolFlags);
    const protoExpr = `(${urlVar}.protocol.endsWith(":")?${urlVar}.protocol.slice(0,-1):${urlVar}.protocol)`;
    inner += emit`
      ${lastIndexReset(re, check.protocolFlags)}
      if(!${re}.test(${protoExpr})){
        ${invalidFormat(g, "url", {
          extra: `note:"Invalid protocol",pattern:${escapeString(check.protocol)}`,
          message: check.message,
        })}
      }`;
  }
  // Zod writes the value back even when hostname/protocol issues were pushed.
  const stripped = check.normalize
    ? `${urlVar}.href`
    : `${trimmedVar}.replace(${g.regex("tnl", "[\\t\\n\\r]", "g")},"")`;
  inner += `${g.output}=${stripped};`;
  let parse = emit`
    var ${urlVar}=null;
    try{${urlVar}=new URL(${trimmedVar});}catch(_){}
    if(${urlVar}===null){
      ${invalidFormat(g, "url", { message: check.message })}
    }else{
      ${inner}
    }`;
  if (!check.normalize && check.protocol === HTTP_PROTOCOL_SOURCE) {
    const re = g.regex("httpUrl", "^https?:\\/\\/", "i");
    parse = emit`
      if(!${re}.test(${trimmedVar})){
        ${invalidFormat(g, "url", { extra: `note:"Invalid URL format"`, message: check.message })}
      }else{
        ${parse}
      }`;
  }
  return emit`
    var ${trimmedVar}=${g.input}.trim();
    ${parse}`;
}

export function slowString(ir: StringIR, g: SlowGen): string {
  let code = "";
  if (ir.coerce) {
    code += emit`try{${g.output}=String(${g.input});}catch(_){}`;
  }
  code += emit`
    if(typeof ${g.input}!=="string"){
      ${invalidType(g, "string")}
      ${whenGatedSizeChecks(ir.checks, g, "length")}
    }`;

  if (ir.checks.length > 0) {
    code += `else{`;
    // Insertion order mirrors zod's issue order for multi-failure inputs;
    // the slow path collects all issues with no short-circuit.
    for (const check of ir.checks) {
      switch (check.kind) {
        // Length is measured in code points where the unit count leaves the
        // verdict in doubt — see stringLengthTests.
        case "min_length":
          code += emit`
            if(${stringLengthTests.minFails(g.input, check.minimum, g.ctx)}){
              ${tooSmall(g, check.minimum, "string", true, { message: check.message })}
            }`;
          break;
        case "max_length":
          code += emit`
            if(${stringLengthTests.maxFails(g.input, check.maximum, g.ctx)}){
              ${tooBig(g, check.maximum, "string", true, { message: check.message })}
            }`;
          break;
        case "length_equals": {
          const length = g.temp("cl");
          code += emit`
            var ${length}=${stringLengthTests.measure(g.input, check.length, g.ctx)};
            if(${length}<${check.length}){
              ${tooSmall(g, check.length, "string", true, { exact: true, message: check.message })}
            }else if(${length}>${check.length}){
              ${tooBig(g, check.length, "string", true, { exact: true, message: check.message })}
            }`;
          break;
        }
        // includes/starts_with/ends_with each carry `origin:"string"` but NO
        // `pattern`: $ZodCheckIncludes/StartsWith/EndsWith bypass
        // $ZodCheckStringFormat entirely (they init from $ZodCheck and assign
        // `inst._zod.check` directly), and the pattern they build is registered
        // in the bag for JSON Schema only, never put on the issue.
        case "includes":
          code += emit`
            if(!${g.input}.includes(${escapeString(check.includes)}${check.position !== undefined ? `,${check.position}` : ""})){
              ${invalidFormat(g, "includes", { origin: "string", extra: `includes:${escapeString(check.includes)}`, message: check.message })}
            }`;
          break;
        case "starts_with":
          code += emit`
            if(!${g.input}.startsWith(${escapeString(check.prefix)})){
              ${invalidFormat(g, "starts_with", { origin: "string", extra: `prefix:${escapeString(check.prefix)}`, message: check.message })}
            }`;
          break;
        case "ends_with":
          code += emit`
            if(!${g.input}.endsWith(${escapeString(check.suffix)})){
              ${invalidFormat(g, "ends_with", { origin: "string", extra: `suffix:${escapeString(check.suffix)}`, message: check.message })}
            }`;
          break;
        case "refine_effect":
          code += refineCheck(check, g.input, g);
          break;
        case "super_refine_effect":
          code += superRefineCheck(check, g.input, g);
          break;
        case "overwrite_effect":
          // $ZodCheckOverwrite: value = tx(value). Later checks read the
          // rewritten value because input aliases the output location.
          code += emit`${g.output}=${emitEffectFn(g.ctx, check.source)}(${g.input});`;
          break;
        case "string_format": {
          let prefix: string;
          let pattern: string;
          // Only the BUILT-IN z.url() gets the URL-parser check, and extraction
          // never gives that one a pattern. A `pattern` on a "url"-named check
          // therefore marks a custom format that merely borrowed the name
          // (`z.stringFormat("url", /re/)`); it validates through its own regex,
          // so fall through and compile that instead of the URL parser.
          if (check.format === "url" && !check.pattern) {
            code += slowUrlCheck(check, g);
            continue;
          }
          if (check.format === "email") {
            pattern = check.pattern ?? EMAIL_REGEX_SOURCE;
            prefix = "email";
          } else if (check.format === "regex" && check.pattern) {
            pattern = check.pattern;
            prefix = "str";
          } else if (check.format === "uuid") {
            pattern = check.pattern ?? UUID_REGEX_SOURCE;
            prefix = "uuid";
          } else {
            if (check.pattern) {
              pattern = check.pattern;
              prefix = "str";
            } else {
              // Extraction guarantees a pattern for non-special formats;
              // defensive skip kept for hand-built IR.
              continue;
            }
          }
          // Zod's default email pattern is tested by the `__zcEmail` scanner, so
          // no RegExp is declared for it at all (see ZC_EMAIL_DECL); the issue
          // below still names the pattern, through the shared source string.
          const scanner = isDefaultEmailPattern(pattern, check.patternFlags)
            ? emitRuntimeHelper(g.ctx, "__zcEmail", ZC_EMAIL_DECL)
            : null;
          const regexVar = scanner === null ? g.regex(prefix, pattern, check.patternFlags) : null;
          // Zod's invalid_format shape depends on WHICH check instance ran.
          // `$ZodCheckStringFormat.init` installs the default pattern check with
          // `??=`, and that default pushes `origin:"string"` + `pattern`. A
          // constructor that OVERRIDES `inst._zod.check` pushes its own issue
          // instead — `$ZodCustomStringFormat` (z.stringFormat/z.hex/z.hostname/
          // z.hash) pushes a bare `{code, format, input}` because it validates
          // through `def.fn` and never reads `def.pattern`. We test the pattern
          // either way, so the issue shape is driven off the extracted flag.
          let extra: string | undefined;
          if (!check.bareIssue) {
            // When emitRegex swapped in a faster equivalent pattern (or the
            // scanner stands in for the RegExp), the runtime regex's toString()
            // would leak the rewrite into the issue. Reference the shared
            // original-pattern string instead (pattern came from RegExp.source,
            // so it matches zod's `.toString()` byte-for-byte).
            const rewritten = !check.patternFlags && fastTestSource(pattern) !== null;
            const patternExpr =
              rewritten || regexVar === null
                ? emitRegexSourceString(g.ctx, pattern)
                : `${regexVar}.toString()`;
            extra = `pattern:${patternExpr}`;
          }
          const test =
            regexVar === null ? `${scanner}(${g.input})` : `${regexVar}.test(${g.input})`;
          code += emit`
            ${regexVar === null ? "" : lastIndexReset(regexVar, check.patternFlags)}
            if(!${test}){
              ${invalidFormat(g, { expr: escapeString(check.format) }, { origin: check.bareIssue ? undefined : "string", extra, message: check.message })}
            }`;
          break;
        }
      }
    }
    code += `}`;
  }

  return `${code}\n`;
}

/**
 * Boolean expression testing ONE compiled string check against `x`, or null when
 * the check is not expressible as a pure predicate (`z.url()`, which trims and
 * normalizes, and an unknown format with no pattern).
 *
 * Shared by the fast path — which sorts the checks cheapest-first and joins them
 * with `&&` — and by the build path, which emits them one statement at a time in
 * DECLARATION order so an interleaved `.trim()` rewrite is visible to the checks
 * that follow it (see buildString).
 */
export function fastStringCheck(check: CheckIR, x: string, ctx: CodeGenContext): string | null {
  switch (check.kind) {
    case "min_length":
      return stringLengthTests.min(x, check.minimum, ctx);
    case "max_length":
      return stringLengthTests.max(x, check.maximum, ctx);
    case "length_equals":
      return stringLengthTests.equals(x, check.length, ctx);
    case "includes":
      return check.position !== undefined
        ? `${x}.includes(${escapeString(check.includes)},${check.position})`
        : `${x}.includes(${escapeString(check.includes)})`;
    case "starts_with":
      return `${x}.startsWith(${escapeString(check.prefix)})`;
    case "ends_with":
      return `${x}.endsWith(${escapeString(check.suffix)})`;
    case "string_format": {
      // URL validation mutates (trims) and uses try/catch — not a predicate.
      // A patterned "url" check is a custom format that borrowed the name (see
      // buildString), and its regex IS a predicate.
      if (check.format === "url" && !check.pattern) return null;
      let pattern: string;
      let prefix: string;
      if (check.format === "email") {
        prefix = "email";
        pattern = check.pattern ?? EMAIL_REGEX_SOURCE;
      } else if (check.format === "uuid") {
        prefix = "uuid";
        pattern = check.pattern ?? UUID_REGEX_SOURCE;
      } else if (check.pattern) {
        prefix = "re";
        pattern = check.pattern;
      } else {
        // Unknown format without pattern — can't generate a check
        return null;
      }
      // Zod's default email pattern runs as a linear scan instead of a RegExp
      // (see ZC_EMAIL_DECL) — a plain call, so it needs no parens either.
      if (isDefaultEmailPattern(pattern, check.patternFlags)) {
        return `${emitRuntimeHelper(ctx, "__zcEmail", ZC_EMAIL_DECL)}(${x})`;
      }
      const v = emitRegex(ctx, prefix, pattern, check.patternFlags);
      // Stateful (g/y) regexes need lastIndex reset; comma expression keeps
      // this usable inside the boolean chain.
      return check.patternFlags && /[gy]/.test(check.patternFlags)
        ? `((${v}.lastIndex=0),${v}.test(${x}))`
        : `${v}.test(${x})`;
    }
    default:
      // A check kind this generator does not model (number/bigint/date/set
      // shapes never reach here from a string node).
      return null;
  }
}

export function fastString(ir: StringIR, g: FastGen): string | null {
  if (ir.coerce) return null;
  // Overwrite effects rewrite the value — the fast path returns input
  // unchanged, so any mutation makes it ineligible.
  if (ir.checks.some((c) => c.kind === "overwrite_effect")) return null;

  const x = g.input;
  const parts: string[] = [`typeof ${x}==="string"`];
  const checks = ir.checks.filter(
    (c): c is CheckIR => c.kind !== "refine_effect" && c.kind !== "overwrite_effect",
  );

  for (const check of checks.sort(checkPriority)) {
    const expr = fastStringCheck(check, x, g.ctx);
    if (expr === null) return null;
    parts.push(expr);
  }

  // Refine effect checks (appended last — run after cheap checks short-circuit)
  for (const check of ir.checks) {
    if (check.kind === "refine_effect") {
      parts.push(`${emitEffectCallable(g.ctx, check)}(${x})`);
    } else if (check.kind === "super_refine_effect") {
      parts.push(superRefineFastTest(check, x, g));
    }
  }

  return parts.join("&&");
}
