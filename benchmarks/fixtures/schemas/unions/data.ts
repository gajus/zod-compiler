import type { UIEvent } from "./zod.js";

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
