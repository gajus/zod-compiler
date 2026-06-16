import { validApiResponse10, validUser } from "../objects/data.js";

// Clean inputs — exactly the declared shape, nothing to strip.
export const cleanUser = validUser;
export const cleanApiResponse = validApiResponse10;

// Dirty inputs — the realistic untrusted-payload case: extra keys a client
// slipped in (overposting). Zod and strip-mode drop them; keep-mode forwards
// them through by reference.
export const dirtyUser = {
  ...validUser,
  is_admin: true,
  __extra: "injected",
  internalId: 9001,
};

export const dirtyApiResponse = {
  ...validApiResponse10,
  leaked: "top-level",
  data: {
    ...validApiResponse10.data,
    injected: true,
    items: validApiResponse10.data?.items.map((item) => ({
      ...item,
      sneaky: "extra",
      metadata: { ...item.metadata, hidden: 1 },
    })),
  },
};

// Wide flat object — 20 declared keys — to show how the per-key copy scales.
export const cleanWide: Record<string, number> = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [`f${i}`, i]),
);

export const dirtyWide: Record<string, number> = {
  ...cleanWide,
  ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`x${i}`, i])),
};
