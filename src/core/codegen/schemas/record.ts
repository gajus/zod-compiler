import type { RecordIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emitRuntimeHelper, extendPath, hasMutation } from "../context.js";
import { emit } from "../emit.js";
import { invalidType } from "../emit-issue.js";
import { ZC_HOP_DECL } from "../issue-decls.js";

export function slowRecord(ir: SchemaIR & { type: "record" }, g: SlowGen): string {
  let code = emit`
    if(typeof ${g.input}!=="object"||${g.input}===null||Array.isArray(${g.input})){
      ${invalidType(g, "record")}
    }else{`;

  if (hasMutation(ir.valueType)) {
    code += `${g.output}={...${g.input}};`;
  }

  const keyVar = g.temp("rkey");
  const keyIssuesVar = g.temp("rki");
  const keyPath = extendPath(g.path, keyVar);
  const valExpr = `${g.input}[${keyVar}]`;
  // for-in + hasOwnProperty guard instead of Object.keys(): identical
  // own-enumerable string-key set and iteration order, no keys-array
  // allocation. When the value type mutates (coerce/default/.trim()) the clone
  // above has already replaced g.input, so this iterates the clone exactly as
  // the Object.keys form did — the key set is stable (values change, keys
  // don't). Records whose values mutate run this path eagerly, so they get the
  // same speedup the fast path does.
  const hop = emitRuntimeHelper(g.ctx, "__zcHop", ZC_HOP_DECL);

  code += emit`
    for(var ${keyVar} in ${g.input}){
      if(!${hop}.call(${g.input},${keyVar}))continue;
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
  // Key + value checks share one fresh scope — they live in the same emitted
  // helper function, size-gated independently of the caller.
  const body = g.scoped(kv);
  const keyCheck = plainStringKey ? "true" : body.visit(ir.keyType, { input: kv });
  // Hoist o[k] into a loop variable: computed-key lookups don't get V8's load
  // elimination across check boundaries, so each repeated o[k] would re-walk
  // the (often dictionary-mode) object.
  const valCheck = body.visit(ir.valueType, { input: vv });
  if (keyCheck === null || valCheck === null) return null;

  const conditions: string[] = [];
  if (keyCheck !== "true") conditions.push(keyCheck);
  if (valCheck !== "true") conditions.push(valCheck);

  if (conditions.length > 0) {
    const helperName = g.temp("rf");
    const valAssign = valCheck !== "true" ? `${vv}=o[${kv}];` : "";
    // for-in (no Object.keys array allocation) + hasOwnProperty guard. The
    // guard restricts iteration to own enumerable string keys — the exact set
    // Object.keys/the slow path produce — so inherited enumerable props can't
    // make the fast check disagree with the deferred slow walk. Measured 2.9x
    // (5 keys) to 5.8x (20 keys) faster than the Object.keys form; the hoisted
    // __zcHop.call inlines, making the guard ~free vs an unguarded for-in.
    const hop = emitRuntimeHelper(g.ctx, "__zcHop", ZC_HOP_DECL);
    g.ctx.preamble.push(
      `function ${helperName}(o){var ${kv},${vv};for(${kv} in o){if(${hop}.call(o,${kv})){${valAssign}if(!(${conditions.join("&&")})){return false;}}}return true;}`,
    );
    parts.push(`${helperName}(${x})`);
  }

  return parts.join("&&");
}
