import type { LargeUIEvent, UIEvent } from "./zod.js";

export const validClickEvent: UIEvent = {
  type: "click",
  x: 100,
  y: 200,
  target: "button#submit",
};

export const validScrollEvent: UIEvent = {
  type: "scroll",
  direction: "down",
  delta: 120,
};

export const validKeypressEvent: UIEvent = {
  type: "keypress",
  key: "Enter",
  modifiers: ["ctrl", "shift"],
};

// One valid input per option of LargeDiscriminatedUnionSchema. The benchmark
// rotates through all eight so the compiled switch dispatches to every case —
// realistic for a discriminated-union validator and immune to monomorphic
// single-case speculation that could mask the per-case guard cost.
export const validLargeEvents: LargeUIEvent[] = [
  { type: "click", x: 100, y: 200, target: "button#submit" },
  { type: "scroll", direction: "down", delta: 120 },
  { type: "keypress", key: "Enter", modifiers: ["ctrl", "shift"] },
  { type: "focus", elementId: "field-email", tabIndex: 3 },
  { type: "blur", elementId: "field-email" },
  { type: "submit", formId: "checkout", fields: ["email", "card"] },
  { type: "resize", width: 1920, height: 1080 },
  { type: "drag", fromX: 0, fromY: 0, toX: 50, toY: 75 },
];
