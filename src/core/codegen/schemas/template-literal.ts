import type { TemplateLiteralIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emit } from "../emit.js";
import { invalidFormat, invalidType } from "../emit-issue.js";

export function slowTemplateLiteral(ir: TemplateLiteralIR, g: SlowGen): string {
  const regexVar = g.regex("tl", ir.pattern);
  return `${emit`
    if(typeof ${g.input}!=="string"){
      ${invalidType(g, "string")}
    }else if(!${regexVar}.test(${g.input})){
      ${invalidFormat(g, "template_literal", { extra: `pattern:${regexVar}.toString()` })}
    }`}\n`;
}

export function fastTemplateLiteral(ir: TemplateLiteralIR, g: FastGen): string | null {
  const regexVar = g.regex("tl", ir.pattern);
  return `typeof ${g.input}==="string"&&${regexVar}.test(${g.input})`;
}
