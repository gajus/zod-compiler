import typia, { type tags } from "typia";

interface ClickEvent {
  type: "click";
  x: number & tags.Type<"int32">;
  y: number & tags.Type<"int32">;
  target: string & tags.MinLength<1>;
}

interface ScrollEvent {
  type: "scroll";
  direction: "up" | "down";
  delta: number & tags.ExclusiveMinimum<0>;
}

interface KeypressEvent {
  type: "keypress";
  key: string & tags.MinLength<1>;
  modifiers: string[];
}

type UIEvent = ClickEvent | ScrollEvent | KeypressEvent;

// ─── createValidate (with errors) ───────────────────────────────────────────

export const typiaValidateDiscriminatedUnion = typia.createValidate<UIEvent>();
