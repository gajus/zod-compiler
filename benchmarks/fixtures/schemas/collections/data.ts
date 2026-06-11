export const validTuple = ["hello", 42, true] as const;

export const validRecord: Record<string, number> = {
  alpha: 1,
  beta: 2,
  gamma: 3,
  delta: 4,
  epsilon: 5,
};

export const validSet5 = new Set(["alpha", "beta", "gamma", "delta", "epsilon"]);

export const validSet20 = new Set(Array.from({ length: 20 }, (_, i) => `item_${i}`));

export const validMap5 = new Map<string, number>([
  ["alpha", 1],
  ["beta", 2],
  ["gamma", 3],
  ["delta", 4],
  ["epsilon", 5],
]);

export const validMap20 = new Map<string, number>(
  Array.from({ length: 20 }, (_, i) => [`key_${i}`, i] as [string, number]),
);

export const validPipe = "hello world";
