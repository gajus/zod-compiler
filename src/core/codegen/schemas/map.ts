import type { MapIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { extendPath, hasMutation } from "../context.js";
import { emit } from "../emit.js";
import { invalidType } from "../emit-issue.js";

export function slowMap(ir: SchemaIR & { type: "map" }, g: SlowGen): string {
  const entryVar = g.temp("map_e");
  const idxVar = g.temp("map_i");
  // Mutating key/value schemas (coerce, .trim(), url) rewrite the entry tuple,
  // which a Map cannot reflect — rebuild into a fresh Map (mirrors Zod).
  const mutates = hasMutation(ir.keyType) || hasMutation(ir.valueType);
  const rebuiltVar = mutates ? g.temp("map_n") : "";

  return `${emit`
    if(!(${g.input} instanceof Map)){
      ${invalidType(g, "map")}
    }else{
      ${mutates ? `var ${rebuiltVar}=new Map();` : ""}
      var ${idxVar}=0;
      for(var ${entryVar} of ${g.input}){
        ${g.visit(ir.keyType, { input: `${entryVar}[0]`, output: `${entryVar}[0]`, path: extendPath(g.path, `${idxVar},"key"`) })}
        ${g.visit(ir.valueType, { input: `${entryVar}[1]`, output: `${entryVar}[1]`, path: extendPath(g.path, `${idxVar},"value"`) })}
        ${mutates ? `${rebuiltVar}.set(${entryVar}[0],${entryVar}[1]);` : ""}
        ${idxVar}++;
      }
      ${mutates ? `${g.output}=${rebuiltVar};` : ""}
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
      `function ${helperName}(m){for(var ${entryVar} of m){if(!(${combined})){return false;}}return true;}`,
    );
    parts.push(`${helperName}(${x})`);
  }

  return parts.join("&&");
}
