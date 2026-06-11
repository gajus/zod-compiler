import type { FileIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { escapeString } from "../context.js";
import { emit } from "../emit.js";
import { invalidType, invalidValue, tooBig, tooSmall } from "../emit-issue.js";

export function slowFile(ir: FileIR, g: SlowGen): string {
  let code = emit`
    if(!(${g.input} instanceof File)){
      ${invalidType(g, "file")}
    }else{`;

  if (ir.checks) {
    for (const check of ir.checks) {
      switch (check.kind) {
        case "min_size":
          code += emit`
            if(${g.input}.size<${check.minimum}){
              ${tooSmall(g, check.minimum, "file", true, { message: check.message })}
            }`;
          break;
        case "max_size":
          code += emit`
            if(${g.input}.size>${check.maximum}){
              ${tooBig(g, check.maximum, "file", true, { message: check.message })}
            }`;
          break;
        case "mime_type": {
          if (check.mime.length === 0) break;
          const mimeValuesExpr = JSON.stringify(check.mime);
          if (check.mime.length === 1) {
            code += emit`
              if(${g.input}.type!==${escapeString(check.mime[0] as string)}){
                ${invalidValue(g, mimeValuesExpr, { message: check.message, useTypeMsg: false })}
              }`;
          } else {
            const setVar = g.set("mime", check.mime);
            code += emit`
              if(!${setVar}.has(${g.input}.type)){
                ${invalidValue(g, mimeValuesExpr, { message: check.message, useTypeMsg: false })}
              }`;
          }
          break;
        }
      }
    }
  }

  code += emit`}`;
  return `${code}\n`;
}

export function fastFile(ir: FileIR, g: FastGen): string | null {
  const x = g.input;
  const parts: string[] = [`${x} instanceof File`];

  if (ir.checks) {
    for (const check of ir.checks) {
      switch (check.kind) {
        case "min_size":
          parts.push(`${x}.size>=${check.minimum}`);
          break;
        case "max_size":
          parts.push(`${x}.size<=${check.maximum}`);
          break;
        case "mime_type":
          if (check.mime.length === 0) break;
          if (check.mime.length === 1) {
            parts.push(`${x}.type===${escapeString(check.mime[0] as string)}`);
          } else {
            const setVar = g.temp("mimeSet");
            g.ctx.preamble.push(`var ${setVar}=new Set(${JSON.stringify(check.mime)});`);
            parts.push(`${setVar}.has(${x}.type)`);
          }
          break;
      }
    }
  }

  return parts.join("&&");
}
