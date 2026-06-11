import type { z } from "zod";
import type { TreeNodeSchema } from "./zod.js";

function makeTree(depth: number, breadth: number): z.infer<typeof TreeNodeSchema> {
  if (depth <= 0) return { value: "leaf", children: [] };
  return {
    value: `node-d${depth}`,
    children: Array.from({ length: breadth }, () => makeTree(depth - 1, breadth)),
  };
}

export const validTreeShallow = makeTree(2, 2); // 7 nodes
export const validTreeDeep = makeTree(4, 3); // 121 nodes
