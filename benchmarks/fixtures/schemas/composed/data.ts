import type { ComposedItem, ComposedTaggedItem } from "./zod.js";

function makeItem(index: number): ComposedItem {
  return {
    id: index + 1,
    username: `user_${index + 1}`,
    email: `user${index + 1}@example.com`,
    role: index % 5 === 0 ? "admin" : "user",
    active: index % 3 !== 0,
    ...(index % 2 === 0 ? { referral: "newsletter" } : {}),
  };
}

export const validComposedItem = makeItem(0);

export const validComposedPage = {
  items: Array.from({ length: 20 }, (_unused, index) => makeItem(index)),
  total: 20,
  nextCursor: null,
};

export const validComposedTaggedPage: {
  items: ComposedTaggedItem[];
  total: number;
  nextCursor: null;
} = {
  items: Array.from({ length: 20 }, (_unused, index) => ({
    ...makeItem(index),
    tags: ["new", `cohort-${index % 4}`],
  })),
  total: 20,
  nextCursor: null,
};
