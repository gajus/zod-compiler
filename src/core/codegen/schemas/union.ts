import type { SchemaIR, UnionIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { hasMutation } from "../context.js";
import { emit } from "../emit.js";

export function slowUnion(ir: SchemaIR & { type: "union" }, g: SlowGen): string {
  const resultVar = g.temp("u");
  const errorsVar = g.temp("ue");
  let code = `var ${resultVar}=false;var ${errorsVar}=[];`;

  // If any option can mutate output (default, catch, coerce, effect),
  // each branch gets its own temp output to prevent cross-branch leaks.
  const needsOutputIsolation = ir.options.some(hasMutation);

  for (const option of ir.options) {
    const tmpIssues = g.temp("ui");
    const innerIdx = g.temp("ufi");

    if (needsOutputIsolation) {
      const tmpOutput = g.temp("uo");
      code += emit`
        if(!${resultVar}){
          var ${tmpIssues}=[];
          var ${tmpOutput}=${g.input};
          ${g.visit(option, { issues: tmpIssues, input: tmpOutput, output: tmpOutput })}
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
          }
        }`;
    } else {
      code += emit`
        if(!${resultVar}){
          var ${tmpIssues}=[];
          ${g.visit(option, { issues: tmpIssues })}
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
          }
        }`;
    }
  }

  // Mirrors zod's handleUnionResults pruning: an option is "aborted" when it
  // produced a parse-level issue (continue !== true in zod — invalid_type and
  // friends); check-level issues (too_small, invalid_format, custom, ...)
  // don't abort. If exactly ONE option is non-aborted, its issues are
  // surfaced directly instead of an invalid_union wrapper.
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
        var ${abVar}=false;
        for(var ${ojVar}=0;${ojVar}<${errorsVar}[${oiVar}].length;${ojVar}++){
          var ${ocVar}=${errorsVar}[${oiVar}][${ojVar}].code;
          if(${ocVar}==="invalid_type"||${ocVar}==="invalid_value"||${ocVar}==="invalid_union"||${ocVar}==="unrecognized_keys"||${ocVar}==="invalid_key"||${ocVar}==="invalid_element"){${abVar}=true;break;}
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
  const optionChecks: string[] = [];
  for (const option of ir.options) {
    const check = g.visit(option);
    if (check === null) return null;
    optionChecks.push(`(${check})`);
  }
  // Wrap in parens — || has lower precedence than && in parent expressions
  return `(${optionChecks.join("||")})`;
}
