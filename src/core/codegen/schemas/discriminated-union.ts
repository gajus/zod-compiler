import type { DiscriminatedUnionIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { escapeString, extendPath, literalToJs } from "../context.js";
import { emit } from "../emit.js";
import { invalidType } from "../emit-issue.js";

export function slowDiscriminatedUnion(
  ir: SchemaIR & { type: "discriminatedUnion" },
  g: SlowGen,
): string {
  const discKey = escapeString(ir.discriminator);

  let code = emit`
    if(typeof ${g.input}!=="object"||${g.input}===null||Array.isArray(${g.input})){
      ${invalidType(g, "object")}
    }else{`;

  const objVar = g.temp("du");
  code += `var ${objVar}=${g.input};switch(${objVar}[${discKey}]){`;

  for (const { value, option: index } of ir.cases) {
    const option = ir.options[index] as SchemaIR;
    code += emit`
      case ${literalToJs(value)}:
        ${g.visit(option, { input: objVar, output: objVar })}
        break;`;
  }

  const validValues = ir.cases.map((c) => literalToJs(c.value)).join(",");
  const msgProp = g.typeMsg === undefined ? "" : `,message:${JSON.stringify(g.typeMsg)}`;
  code += emit`
    default:
      ${g.issues}.push({code:"invalid_union",errors:[],note:"No matching discriminator",discriminator:${discKey},options:[${validValues}]${msgProp},input:${g.input},path:${extendPath(g.path, discKey)}});
    }
  }`;
  return `${code}\n`;
}

export function fastDiscriminatedUnion(ir: DiscriminatedUnionIR, g: FastGen): string | null {
  const x = g.input;
  const discKey = escapeString(ir.discriminator);

  // Generate switch-based dispatch for O(1) discriminator lookup
  const helperName = g.temp("du");
  const helperParam = g.temp("dx");
  const cases: string[] = [];

  // The switch body is its own function: size-gate the options against the cap
  // in a fresh scope, otherwise many small options accumulate into the caller's
  // scope while this helper itself grows unbounded past the TurboFan budget.
  const body = g.scoped(helperParam);
  for (const { value, option: index } of ir.cases) {
    const option = ir.options[index] as SchemaIR;

    // `discSkipKey` tells an object option to drop its own type-guard and
    // discriminator re-check: the caller's guard (`typeof x==="object"&&…`
    // below) already proved object-ness, and this switch case has matched the
    // discriminator value, so re-emitting either is pure redundancy the
    // optimizer only removes when it inlines this helper — which a union large
    // enough to matter won't. Routed through the normal `visit` so size-gated
    // extraction still bounds the switch (the strip survives into any hoisted
    // helper); non-object options ignore the hint and keep their own guard.
    const check = body.visit(option, { discSkipKey: ir.discriminator });
    if (check === null) return null;
    cases.push(`case ${literalToJs(value)}:return ${check};`);
  }

  g.ctx.preamble.push(
    `function ${helperName}(${helperParam}){switch(${helperParam}[${discKey}]){${cases.join("")}default:return false;}}`,
  );

  return `typeof ${x}==="object"&&${x}!==null&&!Array.isArray(${x})&&${helperName}(${x})`;
}
