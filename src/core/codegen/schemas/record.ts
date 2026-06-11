import type { RecordIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { extendPath, hasMutation } from "../context.js";
import { emit } from "../emit.js";
import { invalidType } from "../emit-issue.js";

export function slowRecord(ir: SchemaIR & { type: "record" }, g: SlowGen): string {
  let code = emit`
    if(typeof ${g.input}!=="object"||${g.input}===null||Array.isArray(${g.input})){
      ${invalidType(g, "record")}
    }else{`;

  if (hasMutation(ir.valueType)) {
    code += `${g.output}={...${g.input}};`;
  }

  const keysVar = g.temp("rk");
  const idxVar = g.temp("ri");
  const keyVar = g.temp("rkey");
  const keyIssuesVar = g.temp("rki");
  const keyPath = extendPath(g.path, keyVar);
  const valExpr = `${g.input}[${keyVar}]`;

  code += emit`
    var ${keysVar}=Object.keys(${g.input});
    for(var ${idxVar}=0;${idxVar}<${keysVar}.length;${idxVar}++){
      var ${keyVar}=${keysVar}[${idxVar}];
      var ${keyIssuesVar}=[];
      ${g.visit(ir.keyType, { input: keyVar, output: keyVar, path: keyPath, issues: keyIssuesVar })}
      if(${keyIssuesVar}.length>0){
        ${g.issues}.push({code:"invalid_key",origin:"record"${g.typeMsg === undefined ? "" : `,message:${JSON.stringify(g.typeMsg)}`},path:${keyPath},issues:${keyIssuesVar}});
      }else{
        ${g.visit(ir.valueType, { input: valExpr, output: valExpr, path: keyPath })}
      }
    }
  }`;
  return `${code}\n`;
}

export function fastRecord(ir: RecordIR, g: FastGen): string | null {
  const x = g.input;
  const parts: string[] = [`typeof ${x}==="object"`, `${x}!==null`, `!Array.isArray(${x})`];

  // Object.keys only yields strings — a plain unconstrained string key schema
  // is always satisfied, so skip generating its check entirely.
  const plainStringKey =
    ir.keyType.type === "string" && ir.keyType.checks.length === 0 && ir.keyType.coerce !== true;

  const kv = g.temp("rk");
  const vv = g.temp("rv");
  const keyCheck = plainStringKey ? "true" : g.visit(ir.keyType, { input: kv });
  // Hoist o[k] into a loop variable: computed-key lookups don't get V8's load
  // elimination across check boundaries, so each repeated o[k] would re-walk
  // the (often dictionary-mode) object.
  const valCheck = g.visit(ir.valueType, { input: vv });
  if (keyCheck === null || valCheck === null) return null;

  const conditions: string[] = [];
  if (keyCheck !== "true") conditions.push(keyCheck);
  if (valCheck !== "true") conditions.push(valCheck);

  if (conditions.length > 0) {
    const helperName = g.temp("rf");
    const valAssign = valCheck !== "true" ? `${vv}=o[${kv}];` : "";
    g.ctx.preamble.push(
      `function ${helperName}(o){var ${kv},${vv},ks=Object.keys(o);for(var i=0;i<ks.length;i++){${kv}=ks[i];${valAssign}if(!(${conditions.join("&&")})){return false;}}return true;}`,
    );
    parts.push(`${helperName}(${x})`);
  }

  return parts.join("&&");
}
