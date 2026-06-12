import typia, { type tags } from "typia";

interface Widget {
  id: number & tags.Type<"int32"> & tags.ExclusiveMinimum<0>;
  label: string & tags.MinLength<1> & tags.MaxLength<80>;
  visible: boolean;
  weight: number;
}

interface Panel1 {
  title: string & tags.MinLength<1>;
  a: Widget;
  b: Widget;
  c: Widget;
}
interface Panel2 {
  title: string & tags.MinLength<1>;
  a: Panel1;
  b: Panel1;
  c: Panel1;
}
interface Panel3 {
  title: string & tags.MinLength<1>;
  a: Panel2;
  b: Panel2;
  c: Panel2;
}
interface Panel4 {
  title: string & tags.MinLength<1>;
  a: Panel3;
  b: Panel3;
  c: Panel3;
}

interface DeepLayout {
  name: string & tags.MinLength<1>;
  header: Panel4;
  body: Panel4;
  footer: Panel4;
}

// ─── createValidate (with errors) ───────────────────────────────────────────

export const typiaValidateDeepLayout = typia.createValidate<DeepLayout>();
