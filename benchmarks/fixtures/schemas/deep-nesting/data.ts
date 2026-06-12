import type { DeepLayout } from "./zod.js";

let nextId = 0;
function widget() {
  nextId++;
  return { id: nextId, label: `widget-${nextId}`, visible: nextId % 2 === 0, weight: nextId * 1.5 };
}
function panel1() {
  return { title: "panel-1", a: widget(), b: widget(), c: widget() };
}
function panel2() {
  return { title: "panel-2", a: panel1(), b: panel1(), c: panel1() };
}
function panel3() {
  return { title: "panel-3", a: panel2(), b: panel2(), c: panel2() };
}
function panel4() {
  return { title: "panel-4", a: panel3(), b: panel3(), c: panel3() };
}

// 3 × 3⁴ = 243 leaf widgets.
export const validDeepLayout: DeepLayout = {
  name: "dashboard",
  header: panel4(),
  body: panel4(),
  footer: panel4(),
};
