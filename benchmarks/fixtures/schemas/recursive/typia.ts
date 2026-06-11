import typia, { type tags } from "typia";

interface TreeNode {
  value: string & tags.MinLength<1>;
  children: TreeNode[];
}

// ─── createValidate (with errors) ───────────────────────────────────────────

export const typiaValidateTree = typia.createValidate<TreeNode>();
