import type { SchemaIR, UnionIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { hasMutation } from "../context.js";
import { emit } from "../emit.js";
import { detectUnionDiscriminator, emitFastDiscriminatedSwitch } from "./discriminated-union.js";

export function slowUnion(ir: SchemaIR & { type: "union" }, g: SlowGen): string {
  const resultVar = g.temp("u");
  const errorsVar = g.temp("ue");
  // Parallel to errorsVar: zod's `payload.aborted` for each failed option. Set
  // by a pipe/codec option whose `in` failed (see slowPipe); read during pruning
  // alongside the per-issue code check.
  const abortedVar = g.temp("uea");
  let code = `var ${resultVar}=false;var ${errorsVar}=[];var ${abortedVar}=[];`;

  // If any option can mutate output (default, catch, coerce, effect),
  // each branch gets its own temp output to prevent cross-branch leaks.
  const needsOutputIsolation = ir.options.some(hasMutation);

  for (const option of ir.options) {
    const tmpIssues = g.temp("ui");
    const innerIdx = g.temp("ufi");
    // This option's abort flag, forwarded into the option so a pipe `in` failure
    // can raise it (zod's handlePipeResult). Stays false for every other shape.
    const optAborted = g.temp("uoa");

    if (needsOutputIsolation) {
      const tmpOutput = g.temp("uo");
      code += emit`
        if(!${resultVar}){
          var ${tmpIssues}=[];
          var ${optAborted}=false;
          var ${tmpOutput}=${g.input};
          ${g.visit(option, { issues: tmpIssues, input: tmpOutput, output: tmpOutput, aborted: optAborted })}
          if(${tmpIssues}.length===0){
            ${resultVar}=true;
            ${g.output}=${tmpOutput};
          }else{
            for(var ${innerIdx}=0;${innerIdx}<${tmpIssues}.length;${innerIdx}++){
              if(${tmpIssues}[${innerIdx}].message===undefined&&typeof __zcMsg==="function"){
                ${tmpIssues}[${innerIdx}].message=__zcMsg(${tmpIssues}[${innerIdx}]);
              }
              ${tmpIssues}[${innerIdx}].input=undefined;
            }
            ${errorsVar}.push(${tmpIssues});
            ${abortedVar}.push(${optAborted});
          }
        }`;
    } else {
      code += emit`
        if(!${resultVar}){
          var ${tmpIssues}=[];
          var ${optAborted}=false;
          ${g.visit(option, { issues: tmpIssues, aborted: optAborted })}
          if(${tmpIssues}.length===0){
            ${resultVar}=true;
          }else{
            for(var ${innerIdx}=0;${innerIdx}<${tmpIssues}.length;${innerIdx}++){
              if(${tmpIssues}[${innerIdx}].message===undefined&&typeof __zcMsg==="function"){
                ${tmpIssues}[${innerIdx}].message=__zcMsg(${tmpIssues}[${innerIdx}]);
              }
              ${tmpIssues}[${innerIdx}].input=undefined;
            }
            ${errorsVar}.push(${tmpIssues});
            ${abortedVar}.push(${optAborted});
          }
        }`;
    }
  }

  // Mirrors zod's handleUnionResults pruning (`util.aborted`): an option is
  // "aborted" when its result carries `payload.aborted` (a pipe whose `in`
  // failed — tracked in abortedVar) OR it produced a parse-level issue
  // (continue !== true in zod — invalid_type and friends). Check-level issues
  // (too_small, invalid_format, custom, ...) alone don't abort. If exactly ONE
  // option is non-aborted, its issues are surfaced directly instead of an
  // invalid_union wrapper.
  const msgProp = g.typeMsg === undefined ? "" : `,message:${JSON.stringify(g.typeMsg)}`;
  const naVar = g.temp("una");
  const oiVar = g.temp("uoi");
  const ojVar = g.temp("uoj");
  const abVar = g.temp("uab");
  const ocVar = g.temp("uoc");
  const okVar = g.temp("uok");
  code += emit`
    if(!${resultVar}){
      var ${naVar}=[];
      for(var ${oiVar}=0;${oiVar}<${errorsVar}.length;${oiVar}++){
        var ${abVar}=${abortedVar}[${oiVar}]===true;
        if(!${abVar}){
          for(var ${ojVar}=0;${ojVar}<${errorsVar}[${oiVar}].length;${ojVar}++){
            var ${ocVar}=${errorsVar}[${oiVar}][${ojVar}].code;
            if(${ocVar}==="invalid_type"||${ocVar}==="invalid_value"||${ocVar}==="invalid_union"||${ocVar}==="unrecognized_keys"||${ocVar}==="invalid_key"||${ocVar}==="invalid_element"){${abVar}=true;break;}
          }
        }
        if(!${abVar}){${naVar}.push(${errorsVar}[${oiVar}]);}
      }
      if(${naVar}.length===1){
        for(var ${okVar}=0;${okVar}<${naVar}[0].length;${okVar}++){${g.issues}.push(${naVar}[0][${okVar}]);}
      }else{
        ${g.issues}.push({code:"invalid_union",errors:${errorsVar}${msgProp},input:${g.input},path:${g.path}});
      }
    }`;
  return `${code}\n`;
}

export function fastUnion(ir: UnionIR, g: FastGen): string | null {
  // A plain `z.union` of objects that all pin a shared key to disjoint literals
  // is structurally a discriminated union: dispatch on that key with an O(1)
  // switch instead of probing every arm in sequence. detectUnionDiscriminator
  // returns non-null only when the switch provably accepts exactly what the
  // ||-chain would (disjoint required literals). The slow path is untouched, so
  // error output stays identical to Zod's plain-union behavior.
  const discriminated = detectUnionDiscriminator(ir.options);
  if (discriminated !== null) {
    return emitFastDiscriminatedSwitch(
      g,
      discriminated.discriminator,
      discriminated.cases,
      ir.options,
    );
  }

  const optionChecks: string[] = [];
  for (const option of ir.options) {
    const check = g.visit(option);
    if (check === null) return null;
    optionChecks.push(`(${check})`);
  }
  // Wrap in parens — || has lower precedence than && in parent expressions
  return `(${optionChecks.join("||")})`;
}
