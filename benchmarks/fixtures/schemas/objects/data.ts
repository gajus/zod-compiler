import type { ApiResponse, StrictRow, User } from "./zod.js";

export const validUser: User = {
  username: "alice_dev",
  email: "alice@example.com",
  password: "securepass123",
  age: 28,
  role: "user",
  newsletter: true,
  referral: "bob",
};

export const invalidUser = {
  username: "ab",
  email: "not-email",
  password: "short",
  age: -1,
  role: "superadmin",
  newsletter: "yes",
};

function makeItem(i: number) {
  return {
    id: i + 1,
    title: `Item ${i + 1}`,
    description: `Description for item ${i + 1}`,
    tags: ["tag1", "tag2"],
    published: true,
    category: "tech" as const,
    metadata: {
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-06-01T00:00:00Z",
      views: i * 100,
    },
  };
}

export const validApiResponse10: ApiResponse = {
  status: "success",
  data: {
    items: Array.from({ length: 10 }, (_, i) => makeItem(i)),
    total: 100,
    page: 1,
    pageSize: 10,
    hasMore: true,
  },
};

export const validApiResponse100: ApiResponse = {
  status: "success",
  data: {
    items: Array.from({ length: 100 }, (_, i) => makeItem(i)),
    total: 1000,
    page: 1,
    pageSize: 100,
    hasMore: true,
  },
};

export const validStrictRow: StrictRow = {
  id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  title: "Senior Engineer",
  status: "active",
  rate: 120.5,
  isDefault: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};
