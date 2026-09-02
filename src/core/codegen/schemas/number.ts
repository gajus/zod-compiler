import type { CheckIR, NumberIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { checkPriority, emitEffectCallable, emitRuntimeHelper } from "../context.js";
import { emit } from "../emit.js";
import { invalidType, tooBig, tooSmall } from "../emit-issue.js";
import { ZC_FSR_DECL } from "../issue-decls.js";
import { refineCheck, superRefineCheck, superRefineFastTest } from "./effect.js";

/**
 * The integer number formats, each with the range zod's `NUMBER_FORMAT_RANGES`
 * gives it. `null` for safeint, whose own range IS the safe-integer range that
 * every integer format reports first (see the number_format case below), so it
 * has no range branch of its own. float32/float64 are absent on purpose: they
 * are pure range checks and never report `invalid_type`.
 */
const INT_FORMAT_RANGES: { readonly [format: string]: readonly [number, number] | null } = {
  int32: [-2147483648, 2147483647],
  safeint: null,
  uint32: [0, 4294967295],
};

export function slowNumber(ir: NumberIR, g: SlowGen): string {
  let code = "";
  if (ir.coerce) {
    code += emit`try{${g.output}=Number(${g.input});}catch(_){}`;
  }
  code += emit`
    if(typeof ${g.input}!=="number"){
      ${invalidType(g, "number")}
    }else if(Number.isNaN(${g.input})){
      ${invalidType(g, "number", { extra: 'received:"NaN"' })}
    }else if(!Number.isFinite(${g.input})){
      ${invalidType(g, "number", { extra: `received:String(${g.input})` })}
    }`;

  if (ir.checks.length > 0) {
    code += `else{`;
    // An integer FORMAT check (`.int()`, `.int32()`, `.uint32()`) is the one
    // check here that can report `invalid_type` — non-continuable — and zod's
    // `runChecks` then skips every check after it (`else if (isAborted)
    // continue`). So `z.number().int().min(5)` on 1.5 reports the int failure
    // ALONE, where an ungated chain also volunteers too_small. Its aborting
    // branch is exactly `!Number.isInteger(value)` (the range branches report
    // continuable too_small/too_big, which do NOT stop later checks), so one
    // guard opened after the first such check reproduces zod without any
    // runtime abort bookkeeping. Non-integer formats (float32/float64) never
    // report invalid_type and so never open it.
    const opensIntGuard = (check: (typeof ir.checks)[number]): boolean =>
      check.kind === "number_format" && INT_FORMAT_RANGES[check.format] !== undefined;
    let seenIntFormat = false;
    let intGuardOpen = false;
    // Insertion order mirrors zod's issue order for multi-failure inputs.
    // The slow path collects ALL issues (no short-circuit), so cost ordering
    // buys nothing here — only the fast path's && chain benefits from it.
    for (const check of ir.checks) {
      // Opened lazily, on the first check that actually needs gating: an integer
      // format check in LAST position has nothing after it, so the guard would
      // be dead code.
      if (seenIntFormat && !intGuardOpen) {
        code += `if(Number.isInteger(${g.input})){`;
        intGuardOpen = true;
      }
      switch (check.kind) {
        case "greater_than":
          if (check.inclusive) {
            code += emit`
              if(${g.input}<${check.value}){
                ${tooSmall(g, check.value, "number", true, { message: check.message })}
              }`;
          } else {
            code += emit`
              if(${g.input}<=${check.value}){
                ${tooSmall(g, check.value, "number", false, { message: check.message })}
              }`;
          }
          break;
        case "less_than":
          if (check.inclusive) {
            code += emit`
              if(${g.input}>${check.value}){
                ${tooBig(g, check.value, "number", true, { message: check.message })}
              }`;
          } else {
            code += emit`
              if(${g.input}>=${check.value}){
                ${tooBig(g, check.value, "number", false, { message: check.message })}
              }`;
          }
          break;
        case "number_format": {
          const message = check.message ?? g.typeMsg;
          const intRange = INT_FORMAT_RANGES[check.format];
          if (intRange !== undefined) {
            // Mirrors $ZodCheckNumberFormat's integer branch, in ITS order: a
            // non-integer is an aborting `invalid_type`; an integer outside the
            // SAFE range is reported against the safe bounds — origin "int",
            // zod's explanatory note — and the check returns there, whatever the
            // format's own range says; only a safe integer reaches the format
            // range, reported with origin "number". So `z.int32()` on 1e21 is a
            // too_big with `maximum: 2^53-1` and origin "int", not one with
            // 2147483647 and origin "number" (the format range never runs for it),
            // and the same input against `z.int32().max(10)` reports BOTH the
            // safe-range issue and the max — the safe-range issue is continuable,
            // so later checks still run (see the isInteger guard above). safeint's
            // own range IS the safe range, so its third branch is dead and omitted.
            //
            // Key order is zod's push order minus the fields its finalizer
            // strips: `{code, maximum, note, origin, inclusive}` for the safe
            // range, where a format-range issue leads with `origin` like any
            // check-created size issue.
            const note = `note:"Integers must be within the safe integer range."`;
            const msgProp = message !== undefined ? `,message:${JSON.stringify(message)}` : "";
            code += emit`
              if(!Number.isInteger(${g.input})){
                ${invalidType(g, "int", { extra: `format:"${check.format}"`, extraBeforeCode: true, message })}
              }else if(!Number.isSafeInteger(${g.input})){
                if(${g.input}>0){
                  ${g.issues}.push({code:"too_big",maximum:9007199254740991,${note},origin:"int",inclusive:true,input:${g.input},path:${g.path}${msgProp}});
                }else{
                  ${g.issues}.push({code:"too_small",minimum:-9007199254740991,${note},origin:"int",inclusive:true,input:${g.input},path:${g.path}${msgProp}});
                }
              }`;
            if (intRange !== null) {
              const [minimum, maximum] = intRange;
              code += emit`
                else if(${g.input}<${minimum}){
                  ${tooSmall(g, minimum, "number", true, { message })}
                }else if(${g.input}>${maximum}){
                  ${tooBig(g, maximum, "number", true, { message })}
                }`;
            }
          } else if (check.format === "float32") {
            code += emit`
              if(${g.input}<-3.4028234663852886e+38){
                ${tooSmall(g, "-3.4028234663852886e+38", "number", true, { message })}
              }else if(${g.input}>3.4028234663852886e+38){
                ${tooBig(g, "3.4028234663852886e+38", "number", true, { message })}
              }`;
          }
          // float64 range is [-Number.MAX_VALUE, Number.MAX_VALUE], already covered by the isFinite check above
          break;
        }
        case "multiple_of": {
          const message = check.message ?? g.typeMsg;
          const msgProp = message !== undefined ? `,message:${JSON.stringify(message)}` : "";
          // zod uses a float-safe remainder: raw % mis-rejects 0.3 % 0.1
          const fsr = emitRuntimeHelper(g.ctx, "__zcFsr", ZC_FSR_DECL);
          code += emit`
            if(${fsr}(${g.input},${check.value})!==0){
              ${g.issues}.push({origin:"number",code:"not_multiple_of",divisor:${check.value},input:${g.input},path:${g.path}${msgProp}});
            }`;
          break;
        }
        case "refine_effect":
          code += refineCheck(check, g.input, g);
          break;
        case "super_refine_effect":
          code += superRefineCheck(check, g.input, g);
          break;
      }
      if (opensIntGuard(check)) seenIntFormat = true;
    }
    if (intGuardOpen) code += `}`;
    code += `}`;
  }

  return `${code}\n`;
}

export function fastNumber(ir: NumberIR, g: FastGen): string | null {
  if (ir.coerce) return null;

  const x = g.input;
  const checks = ir.checks.filter((c): c is CheckIR => c.kind !== "refine_effect");

  // Number.isFinite(x) alone implies typeof number && !NaN && finite — zod's
  // entire number type gate in one non-coercing intrinsic. Likewise
  // Number.isSafeInteger covers the safeint format gate. Only the bitwise int
  // formats ((x|0)===x, (x>>>0)===x) still need the typeof guard: applying
  // ToNumber to an arbitrary input would invoke valueOf side effects zod
  // never triggers. Math.fround(Infinity)===Infinity, so float32 keeps the
  // isFinite gate.
  const hasSafeInt = checks.some((c) => c.kind === "number_format" && c.format === "safeint");
  const hasBitwiseInt = checks.some(
    (c) => c.kind === "number_format" && (c.format === "int32" || c.format === "uint32"),
  );
  const parts: string[] = [];
  if (hasBitwiseInt) {
    parts.push(`typeof ${x}==="number"`);
  } else if (!hasSafeInt) {
    parts.push(`Number.isFinite(${x})`);
  }

  for (const check of checks.sort(checkPriority)) {
    switch (check.kind) {
      case "number_format":
        switch (check.format) {
          case "safeint":
            parts.push(`Number.isSafeInteger(${x})`);
            break;
          case "int32":
            parts.push(`(${x}|0)===${x}`);
            break;
          case "uint32":
            parts.push(`${x}>=0`, `${x}<=4294967295`, `(${x}>>>0)===${x}`);
            break;
          case "float32":
            // zod's float32 check is a pure RANGE check (3.14 is accepted
            // even though Math.fround(3.14) !== 3.14) — fround here would
            // make the fast path stricter than the slow path / zod.
            parts.push(`${x}>=-3.4028234663852886e+38`, `${x}<=3.4028234663852886e+38`);
            break;
          case "float64":
            // All finite numbers are valid float64
            break;
        }
        break;
      case "greater_than":
        parts.push(check.inclusive ? `${x}>=${check.value}` : `${x}>${check.value}`);
        break;
      case "less_than":
        parts.push(check.inclusive ? `${x}<=${check.value}` : `${x}<${check.value}`);
        break;
      case "multiple_of": {
        const fsr = emitRuntimeHelper(g.ctx, "__zcFsr", ZC_FSR_DECL);
        parts.push(`${fsr}(${x},${check.value})===0`);
        break;
      }
      case "min_length":
      case "max_length":
      case "length_equals":
      case "string_format":
      case "includes":
      case "starts_with":
      case "ends_with":
        // String-only checks on a number schema — shouldn't happen, skip
        break;
    }
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
