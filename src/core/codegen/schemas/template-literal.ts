import type { TemplateLiteralIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emitConstant, escapeString } from "../context.js";
import { emit } from "../emit.js";
import { invalidFormat, invalidType } from "../emit-issue.js";
import { fastTestSource } from "../well-known-regex.js";

export function slowTemplateLiteral(ir: TemplateLiteralIR, g: SlowGen): string {
  const regexVar = g.regex("tl", ir.pattern);
  // $ZodTemplateLiteral reports `pattern: inst._zod.pattern.source` — the BARE
  // source, with no enclosing slashes. That is the opposite of every string
  // FORMAT check, which zod reports as `def.pattern.toString()`; the shared
  // emitRegexSourceString helper (and its `<name>Src` virtual exports) produces
  // the slash-wrapped form for those, so it cannot serve this site.
  //
  // Same rewrite rule as slowString though: when emitRegex swapped in a faster
  // equivalent pattern, the runtime regex's own `.source` would leak the
  // rewrite, so the ORIGINAL source is emitted as a constant instead. IR
  // `pattern` IS a `.source` string (see extractTemplateLiteral), so it is
  // byte-identical to what zod reads.
  const patternExpr =
    fastTestSource(ir.pattern) === null
      ? `${regexVar}.source`
      : emitConstant(g.ctx, "tls", escapeString(ir.pattern));
  // The issue is pushed by the NODE (`$ZodTemplateLiteral._zod.parse`), not by
  // a `$ZodCheck`, so zod's carries no `continue: true` and `util.aborted`
  // counts it as aborting: a union option that fails only here goes inside
  // `invalid_union` rather than being surfaced as the sole non-aborted option,
  // and a container's `.refine()` does not run after it. Every other
  // `invalid_format` is check-raised and continuable, so the marker is set here
  // rather than in the shared factory; the finalizer deletes it, as zod's does.
  return `${emit`
    if(typeof ${g.input}!=="string"){
      ${invalidType(g, "string")}
    }else if(!${regexVar}.test(${g.input})){
      ${invalidFormat(g, "template_literal", { extra: `pattern:${patternExpr},continue:false` })}
    }`}\n`;
}

export function fastTemplateLiteral(ir: TemplateLiteralIR, g: FastGen): string | null {
  const regexVar = g.regex("tl", ir.pattern);
  return `typeof ${g.input}==="string"&&${regexVar}.test(${g.input})`;
}
