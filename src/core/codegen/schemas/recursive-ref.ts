import type { RecursiveRefIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emit } from "../emit.js";

export function slowRecursiveRef(_ir: RecursiveRefIR, g: SlowGen): string {
  const n = g.ctx.counter++;
  const rVar = `__rec_r${n}`;
  const iVar = `__rec_i${n}`;
  const jVar = `__rec_j${n}`;
  return `${emit`
    var ${rVar}=${g.ctx.fnName}(${g.input});
    if(!${rVar}.success){
      var ${iVar}=${rVar}.error.issues;
      for(var ${jVar}=0;${jVar}<${iVar}.length;${jVar}++){
        ${g.issues}.push({...${iVar}[${jVar}],
          path:${g.path}.concat(${iVar}[${jVar}].path)});
      }
    }else{
      ${g.output}=${rVar}.data;
    }
  `}\n`;
}

export function fastRecursiveRef(_ir: RecursiveRefIR, g: FastGen): string | null {
  // recursiveRef always targets the root schema (only direct self-recursion
  // compiles; everything else falls back). Emit a call to the root fast-check
  // helper; generateValidator declares it once the root expression is known.
  const ctx = g.ctx;
  if (ctx.recFastName === undefined) {
    ctx.recFastName = `__fcr_${ctx.counter++}`;
  }
  return `${ctx.recFastName}(${g.input})`;
}
