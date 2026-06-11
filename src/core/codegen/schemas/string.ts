import type { CheckIR, CheckStringFormat, StringIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { checkPriority, emitEffectFn, emitRegexSourceString, escapeString } from "../context.js";
import { emit } from "../emit.js";
import { invalidFormat, invalidType, tooBig, tooSmall } from "../emit-issue.js";
import {
  EMAIL_REGEX_SOURCE,
  lookupFastRegexSource,
  UUID_REGEX_SOURCE,
} from "../well-known-regex.js";
import { refineCheck } from "./effect.js";

/** `re.lastIndex=0;` reset statement for stateful (g/y-flagged) regexes. */
function lastIndexReset(regexVar: string, flags: string | undefined): string {
  return flags && /[gy]/.test(flags) ? `${regexVar}.lastIndex=0;` : "";
}

/**
 * Generate the url check, mirroring $ZodURL semantics:
 * trim → new URL(trimmed) → optional hostname/protocol regex tests →
 * write back url.href (normalize) or the trimmed input.
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
  inner += `${g.output}=${check.normalize ? `${urlVar}.href` : trimmedVar};`;
  return emit`
    var ${trimmedVar}=${g.input}.trim();
    var ${urlVar}=null;
    try{${urlVar}=new URL(${trimmedVar});}catch(_){}
    if(${urlVar}===null){
      ${invalidFormat(g, "url", { message: check.message })}
    }else{
      ${inner}
    }`;
}

export function slowString(ir: StringIR, g: SlowGen): string {
  let code = "";
  if (ir.coerce) {
    code += emit`try{${g.output}=String(${g.input});}catch(_){}`;
  }
  code += emit`
    if(typeof ${g.input}!=="string"){
      ${invalidType(g, "string")}
    }`;

  if (ir.checks.length > 0) {
    code += `else{`;
    // Insertion order mirrors zod's issue order for multi-failure inputs;
    // the slow path collects all issues with no short-circuit.
    for (const check of ir.checks) {
      switch (check.kind) {
        case "min_length":
          code += emit`
            if(${g.input}.length<${check.minimum}){
              ${tooSmall(g, check.minimum, "string", true, { message: check.message })}
            }`;
          break;
        case "max_length":
          code += emit`
            if(${g.input}.length>${check.maximum}){
              ${tooBig(g, check.maximum, "string", true, { message: check.message })}
            }`;
          break;
        case "length_equals":
          code += emit`
            if(${g.input}.length<${check.length}){
              ${tooSmall(g, check.length, "string", true, { exact: true, message: check.message })}
            }else if(${g.input}.length>${check.length}){
              ${tooBig(g, check.length, "string", true, { exact: true, message: check.message })}
            }`;
          break;
        case "includes":
          code += emit`
            if(!${g.input}.includes(${escapeString(check.includes)}${check.position !== undefined ? `,${check.position}` : ""})){
              ${invalidFormat(g, "includes", { extra: `includes:${escapeString(check.includes)}`, message: check.message })}
            }`;
          break;
        case "starts_with":
          code += emit`
            if(!${g.input}.startsWith(${escapeString(check.prefix)})){
              ${invalidFormat(g, "starts_with", { extra: `prefix:${escapeString(check.prefix)}`, message: check.message })}
            }`;
          break;
        case "ends_with":
          code += emit`
            if(!${g.input}.endsWith(${escapeString(check.suffix)})){
              ${invalidFormat(g, "ends_with", { extra: `suffix:${escapeString(check.suffix)}`, message: check.message })}
            }`;
          break;
        case "refine_effect":
          code += refineCheck(check, g.input, g);
          break;
        case "overwrite_effect":
          // $ZodCheckOverwrite: value = tx(value). Later checks read the
          // rewritten value because input aliases the output location.
          code += emit`${g.output}=${emitEffectFn(g.ctx, check.source)}(${g.input});`;
          break;
        case "string_format": {
          let regexVar: string;
          let pattern: string;
          if (check.format === "url") {
            code += slowUrlCheck(check, g);
            continue;
          }
          if (check.format === "email") {
            pattern = check.pattern ?? EMAIL_REGEX_SOURCE;
            regexVar = g.regex("email", pattern, check.patternFlags);
          } else if (check.format === "regex" && check.pattern) {
            pattern = check.pattern;
            regexVar = g.regex("str", pattern, check.patternFlags);
          } else if (check.format === "uuid") {
            pattern = check.pattern ?? UUID_REGEX_SOURCE;
            regexVar = g.regex("uuid", pattern, check.patternFlags);
          } else {
            if (check.pattern) {
              pattern = check.pattern;
              regexVar = g.regex("str", pattern, check.patternFlags);
            } else {
              // Extraction guarantees a pattern for non-special formats;
              // defensive skip kept for hand-built IR.
              continue;
            }
          }
          // When emitRegex swapped in a faster equivalent pattern, the runtime
          // regex's toString() would leak the rewrite into the issue. Reference
          // the shared original-pattern string instead (pattern came from
          // RegExp.source, so it matches zod's `.toString()` byte-for-byte).
          const rewritten = !check.patternFlags && lookupFastRegexSource(pattern) !== null;
          const patternExpr = rewritten
            ? emitRegexSourceString(g.ctx, pattern)
            : `${regexVar}.toString()`;
          code += emit`
            ${lastIndexReset(regexVar, check.patternFlags)}
            if(!${regexVar}.test(${g.input})){
              ${invalidFormat(g, { expr: escapeString(check.format) }, { extra: `pattern:${patternExpr},origin:"string"`, message: check.message })}
            }`;
          break;
        }
      }
    }
    code += `}`;
  }

  return `${code}\n`;
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
    switch (check.kind) {
      case "min_length":
        parts.push(`${x}.length>=${check.minimum}`);
        break;
      case "max_length":
        parts.push(`${x}.length<=${check.maximum}`);
        break;
      case "length_equals":
        parts.push(`${x}.length===${check.length}`);
        break;
      case "includes":
        parts.push(
          check.position !== undefined
            ? `${x}.includes(${escapeString(check.includes)},${check.position})`
            : `${x}.includes(${escapeString(check.includes)})`,
        );
        break;
      case "starts_with":
        parts.push(`${x}.startsWith(${escapeString(check.prefix)})`);
        break;
      case "ends_with":
        parts.push(`${x}.endsWith(${escapeString(check.suffix)})`);
        break;
      case "string_format": {
        if (check.format === "url") {
          // URL validation mutates (trims) and uses try/catch — ineligible
          return null;
        }
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
          // Unknown format without pattern — can't generate fast check
          return null;
        }
        const v = g.regex(prefix, pattern, check.patternFlags);
        // Stateful (g/y) regexes need lastIndex reset; comma expression keeps
        // this usable inside the boolean chain.
        parts.push(
          check.patternFlags && /[gy]/.test(check.patternFlags)
            ? `((${v}.lastIndex=0),${v}.test(${x}))`
            : `${v}.test(${x})`,
        );
        break;
      }
    }
  }

  // Refine effect checks (appended last — run after cheap checks short-circuit)
  for (const check of ir.checks) {
    if (check.kind === "refine_effect") {
      parts.push(`${emitEffectFn(g.ctx, check.source)}(${x})`);
    }
  }

  return parts.join("&&");
}
