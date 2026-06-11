export const validEventLog = {
  sessionId: "550e8400-e29b-41d4-a716-446655440000",
  events: [
    { type: "click" as const, x: 100, y: 200, target: "button" },
    { type: "scroll" as const, direction: "down" as const, delta: 120 },
    { type: "keypress" as const, key: "Enter", modifiers: ["ctrl"] },
    { type: "click" as const, x: 50, y: 75, target: "link" },
    { type: "scroll" as const, direction: "up" as const, delta: 60 },
  ],
  dimensions: [1920, 1080] as [number, number],
  tags: { browser: "chrome", os: "macos", version: "120" },
  startedAt: new Date("2025-01-01T00:00:00Z"),
  config: { sampleRate: 0.5, debug: false },
};

export const validPartialFallbackObject = {
  id: 1,
  name: "Alice Developer",
  email: "alice@example.com",
  slug: "Alice Developer",
  role: "admin" as const,
  isActive: true,
};

function makeFallbackItem(i: number) {
  return {
    id: i + 1,
    title: `Item ${i + 1}`,
    normalizedTitle: ` Item ${i + 1} `,
    tags: ["tag1", "tag2"],
    score: (i + 1) * 10.5,
  };
}

export const validFallbackArray10 = Array.from({ length: 10 }, (_, i) => makeFallbackItem(i));
export const validFallbackArray50 = Array.from({ length: 50 }, (_, i) => makeFallbackItem(i));
