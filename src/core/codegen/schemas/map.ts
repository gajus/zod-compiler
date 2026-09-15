import type { MapIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { declareFastTemps, emitRuntimeHelper, hasMutation } from "../context.js";
import { emit } from "../emit.js";
import { invalidType } from "../emit-issue.js";
import { propertyKeyTest, ZC_FZ_DECL, ZC_PFX_DECL } from "../issue-decls.js";

/**
 * Map entries report through zod's `handleMapResult`, which branches on the
 * RUNTIME type of the key rather than on the key schema:
 *
 * - a property-key type (string | number | symbol) addresses the entry, so key
 *   AND value issues are prefixed with the key itself → `[...mapPath, key, …]`.
 *   This holds even when the key is the wrong type for the schema — a `number`
 *   key under `z.map(z.string(), …)` still reports at `[5]`.
 * - anything else (boolean, bigint, object, …) cannot be a path segment, so the
 *   issues are WRAPPED: key issues into one `invalid_key`, value issues into one
 *   `invalid_element` carrying the offending `key`, both at the map's own path
 *   with the originals nested and finalized.
 *
 * The key is snapshotted before validation because zod passes the ORIGINAL key
 * to both the type test and the prefix, and a mutating key schema (`.trim()`)
 * would otherwise have rewritten it by then.
 */
export function slowMap(ir: SchemaIR & { type: "map" }, g: SlowGen): string {
  const entryVar = g.temp("map_e");
  const keyVar = g.temp("map_k");
  const pkVar = g.temp("map_pk");
  const keyIssues = g.temp("map_ki");
  const valIssues = g.temp("map_vi");
  const msgProp = g.typeMsg === undefined ? "" : `,message:${JSON.stringify(g.typeMsg)}`;
  const fz = emitRuntimeHelper(g.ctx, "__zcFz", ZC_FZ_DECL);
  const pfx = emitRuntimeHelper(g.ctx, "__zcPfx", ZC_PFX_DECL);

  // Key and value are validated into scratch arrays at a path RELATIVE to the
  // entry, exactly as zod runs them on a fresh payload — whichever branch the
  // key's type selects then decides where those paths get rooted.
  //
  // Both are read out of the entry into locals and never written back into it:
  // the entry array is the iterator's, and a Map subclass can hand out its own.
  // What they produce reaches the output through the rebuilt Map instead.
  const keyOut = g.temp("map_ko");
  const valueOut = g.temp("map_vo");
  let keyCode: string;
  let valCode: string;
  let before = "";
  let collect = "";
  let after = "";
  if (hasMutation(ir.keyType) || hasMutation(ir.valueType)) {
    // A mutating key or value (coerce, .trim(), url) reads back what it wrote,
    // so each keeps one local for both, and every entry is rebuilt into a fresh
    // Map (mirrors Zod).
    const rebuiltVar = g.temp("map_n");
    keyCode =
      `var ${keyOut}=${keyVar};` +
      g.visit(ir.keyType, { input: keyOut, output: keyOut, path: "[]", issues: keyIssues });
    valCode =
      `var ${valueOut}=${entryVar}[1];` +
      g.visit(ir.valueType, { input: valueOut, output: valueOut, path: "[]", issues: valIssues });
    before = `var ${rebuiltVar}=new Map();`;
    collect = `${rebuiltVar}.set(${keyOut},${valueOut});`;
    after = `${g.output}=${rebuiltVar};`;
  } else {
    // A key or value that rewrites nothing can still hand back a REPLACEMENT —
    // a `__proto__`-scrubbed copy, a recursive value rebuilt by its own
    // validator — which zod's output Map holds in its place. Each is given an
    // output local of its own (see visitMember), and the first replacement
    // starts the rebuilt Map: the entries before it, in order, then every
    // entry's output from there on. A Map nothing replaces still comes back by
    // reference, and a side that never names its output is never compared.
    const valueVar = g.temp("map_v");
    const keyVisit = g.visit(ir.keyType, {
      input: keyVar,
      output: keyOut,
      path: "[]",
      issues: keyIssues,
    });
    const valueVisit = g.visit(ir.valueType, {
      input: valueVar,
      output: valueOut,
      path: "[]",
      issues: valIssues,
    });
    const keyWrites = keyVisit.includes(keyOut);
    const valueWrites = valueVisit.includes(valueOut);
    keyCode = `${keyWrites ? `var ${keyOut}=${keyVar};` : ""}${keyVisit}`;
    valCode = `var ${valueVar}=${entryVar}[1];${valueWrites ? `var ${valueOut}=${valueVar};` : ""}${valueVisit}`;
    if (keyWrites || valueWrites) {
      const rebuiltVar = g.temp("map_n");
      const countVar = g.temp("map_c");
      const skipVar = g.temp("map_j");
      const earlierVar = g.temp("map_p");
      const key = keyWrites ? keyOut : keyVar;
      const value = valueWrites ? valueOut : valueVar;
      const replaced = [
        ...(keyWrites ? [`${keyOut}!==${keyVar}`] : []),
        ...(valueWrites ? [`${valueOut}!==${valueVar}`] : []),
      ].join("||");
      before = `var ${rebuiltVar}=null;var ${countVar}=0;`;
      collect = emit`
        if(${rebuiltVar}!==null){
          ${rebuiltVar}.set(${key},${value});
        }else if(${replaced}){
          ${rebuiltVar}=new Map();
          var ${skipVar}=0;
          for(var ${earlierVar} of ${g.input}){
            if(${skipVar}++===${countVar})break;
            ${rebuiltVar}.set(${earlierVar}[0],${earlierVar}[1]);
          }
          ${rebuiltVar}.set(${key},${value});
        }
        ${countVar}++;`;
      after = `if(${rebuiltVar}!==null){${g.output}=${rebuiltVar};}`;
    }
  }

  return `${emit`
    if(!(${g.input} instanceof Map)){
      ${invalidType(g, "map")}
    }else{
      ${before}
      for(var ${entryVar} of ${g.input}){
        var ${keyVar}=${entryVar}[0];
        var ${pkVar}=${propertyKeyTest(keyVar)};
        var ${keyIssues}=[];
        ${keyCode}
        if(${keyIssues}.length>0){
          if(${pkVar}){
            ${pfx}(${g.issues},${keyIssues},${g.path},${keyVar});
          }else{
            ${g.issues}.push({code:"invalid_key",origin:"map",issues:${fz}(${keyIssues}),input:${g.input},path:${g.path}${msgProp}});
          }
        }
        var ${valIssues}=[];
        ${valCode}
        if(${valIssues}.length>0){
          if(${pkVar}){
            ${pfx}(${g.issues},${valIssues},${g.path},${keyVar});
          }else{
            ${g.issues}.push({origin:"map",code:"invalid_element",key:${keyVar},issues:${fz}(${valIssues}),input:${g.input},path:${g.path}${msgProp}});
          }
        }
        ${collect}
      }
      ${after}
    }
  `}\n`;
}

export function fastMap(ir: MapIR, g: FastGen): string | null {
  const x = g.input;
  const parts: string[] = [`${x} instanceof Map`];

  // Key/value validation via preamble helper (Map has no .every()).
  // Key + value share one fresh scope — same emitted helper, size-gated
  // independently of the caller.
  const entryVar = g.temp("me");
  const body = g.scoped(`${entryVar}[0]`);
  const keyCheck = body.visit(ir.keyType, { input: `${entryVar}[0]` });
  if (keyCheck === null) return null;
  const valCheck = body.visit(ir.valueType, { input: `${entryVar}[1]` });
  if (valCheck === null) return null;

  if (keyCheck !== "true" || valCheck !== "true") {
    const combined = [keyCheck, valCheck].filter((c) => c !== "true").join("&&");
    const helperName = g.temp("mh");
    g.ctx.preamble.push(
      `function ${helperName}(m){${declareFastTemps(body.scope)}for(var ${entryVar} of m){if(!(${combined})){return false;}}return true;}`,
    );
    parts.push(`${helperName}(${x})`);
  }

  return parts.join("&&");
}
