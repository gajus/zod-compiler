import { z } from "zod";

// ─── Deep fixed nesting (dashboard layout tree) ─────────────────────────────
// A non-recursive object nested four panel levels deep (3 sub-panels each) down
// to 243 leaf widgets. Its fully-inlined fast-check is far past V8's TurboFan
// budget, so it exercises zod-compiler's size-gated function splitting: the
// monolith would run on the slower Maglev tier, the split version stays on
// TurboFan. Plain `z.object` (non-strict) to match ajv's default / typia.

const Widget = z.object({
  id: z.number().int().positive(),
  label: z.string().min(1).max(80),
  visible: z.boolean(),
  weight: z.number(),
});

const Panel1 = z.object({
  title: z.string().min(1),
  a: Widget,
  b: Widget,
  c: Widget,
});

const Panel2 = z.object({
  title: z.string().min(1),
  a: Panel1,
  b: Panel1,
  c: Panel1,
});

const Panel3 = z.object({
  title: z.string().min(1),
  a: Panel2,
  b: Panel2,
  c: Panel2,
});

const Panel4 = z.object({
  title: z.string().min(1),
  a: Panel3,
  b: Panel3,
  c: Panel3,
});

export const DeepLayoutSchema = z.object({
  name: z.string().min(1),
  header: Panel4,
  body: Panel4,
  footer: Panel4,
});

export type DeepLayout = z.infer<typeof DeepLayoutSchema>;
