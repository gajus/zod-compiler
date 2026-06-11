import type { DateIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { checkPriority } from "../context.js";
import { emit } from "../emit.js";
import { invalidType, tooBig, tooSmall } from "../emit-issue.js";

export function slowDate(ir: DateIR, g: SlowGen): string {
  let code = "";
  if (ir.coerce) {
    code += emit`try{${g.output}=new Date(${g.input});}catch(_){}`;
  }
  code += emit`
    if(!(${g.input} instanceof Date)){
      ${invalidType(g, "date")}
    }else if(isNaN(${g.input}.getTime())){
      ${invalidType(g, "date", { extra: 'received:"Invalid Date"' })}
    }`;

  const checks = ir.checks.filter((c) => !Number.isNaN(c.timestamp));
  if (checks.length > 0) {
    code += `else{`;
    for (const check of checks) {
      const timeExpr = `${g.input}.getTime()`;
      switch (check.kind) {
        case "date_greater_than":
          if (check.inclusive) {
            code += emit`
              if(${timeExpr}<${check.timestamp}){
                ${tooSmall(g, check.timestamp, "date", true, { message: check.message })}
              }`;
          } else {
            code += emit`
              if(${timeExpr}<=${check.timestamp}){
                ${tooSmall(g, check.timestamp, "date", false, { message: check.message })}
              }`;
          }
          break;
        case "date_less_than":
          if (check.inclusive) {
            code += emit`
              if(${timeExpr}>${check.timestamp}){
                ${tooBig(g, check.timestamp, "date", true, { message: check.message })}
              }`;
          } else {
            code += emit`
              if(${timeExpr}>=${check.timestamp}){
                ${tooBig(g, check.timestamp, "date", false, { message: check.message })}
              }`;
          }
          break;
      }
    }
    code += `}`;
  }

  return `${code}\n`;
}

export function fastDate(ir: DateIR, g: FastGen): string | null {
  if (ir.coerce) return null;

  const x = g.input;
  const parts: string[] = [`${x} instanceof Date`];

  // A NaN bound never fires in zod (comparisons with NaN are false) — emit
  // no check at all; `t >= NaN` would reject every date.
  const checks = ir.checks.filter((c) => !Number.isNaN(c.timestamp));
  if (checks.length > 0) {
    // Cache getTime() in a temp variable to avoid repeated calls
    const t = g.temp("dt");
    parts.push(`(${t}=${x}.getTime(),!Number.isNaN(${t}))`);

    for (const check of [...checks].sort(checkPriority)) {
      switch (check.kind) {
        case "date_greater_than":
          parts.push(check.inclusive ? `${t}>=${check.timestamp}` : `${t}>${check.timestamp}`);
          break;
        case "date_less_than":
          parts.push(check.inclusive ? `${t}<=${check.timestamp}` : `${t}<${check.timestamp}`);
          break;
      }
    }
  } else {
    parts.push(`!Number.isNaN(${x}.getTime())`);
  }

  return parts.join("&&");
}
