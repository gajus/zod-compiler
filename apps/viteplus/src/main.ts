import {
  validateAddress,
  validateCategory,
  validateContact,
  validateEvent,
  validateHeaders,
  validateInline,
  validateNotification,
  validateOrder,
  validatePositiveInt,
  validateTagSet,
  validateTreeNode,
  validateUser,
  validateWallet,
} from "./schemas.js";

// oxlint-disable-next-line no-console -- sample app output
const log = console.log;

function test(label: string, fn: () => void): void {
  log(`\n--- ${label} ---`);
  try {
    fn();
  } catch (e) {
    log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- User ---

test("User: valid", () => {
  const result = validateUser.safeParse({
    name: "Alice",
    email: "alice@example.com",
    age: 30,
    role: "admin",
    isActive: true,
    tags: ["dev", "lead"],
    nickname: undefined,
    bio: null,
  });
  log(`  success: ${result.success}`);
  if (result.success) log(`  data.name: ${result.data.name}`);
});

test("User: invalid email", () => {
  const result = validateUser.safeParse({
    name: "Bob",
    email: "not-an-email",
    age: 25,
    role: "viewer",
    isActive: false,
    tags: [],
    bio: null,
  });
  log(`  success: ${result.success}`);
  if (!result.success) log(`  issues: ${result.error?.issues.length}`);
});

test("User: is() type guard", () => {
  const data: unknown = {
    name: "Carol",
    email: "carol@example.com",
    age: 28,
    role: "editor",
    isActive: true,
    tags: ["writer"],
    bio: null,
  };
  log(`  is valid: ${validateUser.safeParse(data).success}`);
  log(`  is invalid: ${validateUser.safeParse({ name: 123 }).success}`);
});

// --- Address (regex) ---

test("Address: valid", () => {
  const result = validateAddress.safeParse({
    street: "1-2-3 Shibuya",
    city: "Tokyo",
    zip: "150-0002",
  });
  log(`  success: ${result.success}`);
});

test("Address: invalid zip", () => {
  const result = validateAddress.safeParse({
    street: "4-5-6 Umeda",
    city: "Osaka",
    zip: "ABC-DEFG",
  });
  log(`  success: ${result.success}`);
  if (!result.success) log(`  issues: ${result.error?.issues.length}`);
});

// --- Contact (intersection) ---

test("Contact: valid", () => {
  const result = validateContact.safeParse({ name: "Dave", phone: "090-1234-5678" });
  log(`  success: ${result.success}`);
});

test("Contact: missing phone", () => {
  const result = validateContact.safeParse({ name: "Dave" });
  log(`  success: ${result.success}`);
});

// --- Event (tuple, date, nested object, literal, default) ---

test("Event: valid", () => {
  const result = validateEvent.safeParse({
    title: "Meetup",
    date: new Date("2026-04-01"),
    attendees: ["Room A", 50],
    metadata: { location: "Tokyo", notes: "Bring laptop" },
    status: "scheduled",
  });
  log(`  success: ${result.success}`);
  if (result.success) log(`  data.priority: ${result.data.priority}`);
});

test("Event: wrong literal", () => {
  const result = validateEvent.safeParse({
    title: "Meetup",
    date: new Date(),
    attendees: ["Room A", 50],
    metadata: {},
    status: "cancelled",
  });
  log(`  success: ${result.success}`);
});

// --- Notification (discriminatedUnion) ---

test("Notification: email", () => {
  const result = validateNotification.safeParse({
    type: "email",
    to: "user@example.com",
    subject: "Hello",
  });
  log(`  success: ${result.success}`);
});

test("Notification: sms", () => {
  const result = validateNotification.safeParse({
    type: "sms",
    phone: "090-0000-0000",
    body: "Hi there",
  });
  log(`  success: ${result.success}`);
});

test("Notification: invalid type", () => {
  const result = validateNotification.safeParse({
    type: "fax",
    number: "03-1234-5678",
  });
  log(`  success: ${result.success}`);
});

test("Notification: missing fields", () => {
  const result = validateNotification.safeParse({
    type: "push",
  });
  log(`  success: ${result.success}`);
  if (!result.success) log(`  issues: ${result.error?.issues.length}`);
});

// --- Order (partial fallback with transform) ---

test("Order: valid", () => {
  const result = validateOrder.safeParse({
    orderId: "ORD-001",
    amount: 99.99,
    currency: "USD",
    slug: "Holiday Sale Item",
    createdAt: new Date("2026-03-01"),
  });
  log(`  success: ${result.success}`);
  if (result.success) log(`  data.slug: ${result.data.slug}`);
});

test("Order: invalid amount", () => {
  const result = validateOrder.safeParse({
    orderId: "ORD-002",
    amount: -10,
    currency: "EUR",
    slug: "Test Order",
    createdAt: new Date(),
  });
  log(`  success: ${result.success}`);
  if (!result.success) log(`  issues: ${result.error?.issues.length}`);
});

// --- Wallet (bigint) ---

test("Wallet: valid", () => {
  const result = validateWallet.safeParse({ balance: 500n, limit: 10000n });
  log(`  success: ${result.success}`);
});

test("Wallet: negative balance", () => {
  const result = validateWallet.safeParse({ balance: -1n, limit: 100n });
  log(`  success: ${result.success}`);
  if (!result.success) log(`  issues: ${result.error?.issues.length}`);
});

// --- TagSet (set) ---

test("TagSet: valid", () => {
  const result = validateTagSet.safeParse(new Set(["typescript", "zod", "aot"]));
  log(`  success: ${result.success}`);
});

test("TagSet: empty (below min)", () => {
  const result = validateTagSet.safeParse(new Set());
  log(`  success: ${result.success}`);
});

// --- Headers (map) ---

test("Headers: valid", () => {
  const headers = new Map([
    ["content-type", "application/json"],
    ["authorization", "Bearer token123"],
  ]);
  const result = validateHeaders.safeParse(headers);
  log(`  success: ${result.success}`);
});

test("Headers: not a Map", () => {
  const result = validateHeaders.safeParse({ "content-type": "text/html" });
  log(`  success: ${result.success}`);
});

// --- PositiveInt (pipe) ---

test("PositiveInt: valid", () => {
  const result = validatePositiveInt.safeParse(42);
  log(`  success: ${result.success}`);
});

test("PositiveInt: zero (not positive)", () => {
  const result = validatePositiveInt.safeParse(0);
  log(`  success: ${result.success}`);
});

test("PositiveInt: float (not int)", () => {
  const result = validatePositiveInt.safeParse(3.14);
  log(`  success: ${result.success}`);
});

// --- Category (non-recursive lazy) ---

test("Category: valid", () => {
  const result = validateCategory.safeParse({ name: "Electronics", description: "Gadgets & tech" });
  log(`  success: ${result.success}`);
});

test("Category: null description", () => {
  const result = validateCategory.safeParse({ name: "Books", description: null });
  log(`  success: ${result.success}`);
});

test("Category: empty name (too short)", () => {
  const result = validateCategory.safeParse({ name: "", description: null });
  log(`  success: ${result.success}`);
  if (!result.success) log(`  issues: ${result.error?.issues.length}`);
});

// --- TreeNode (recursive lazy) ---

test("TreeNode: leaf", () => {
  const result = validateTreeNode.safeParse({ value: "root", children: [] });
  log(`  success: ${result.success}`);
});

test("TreeNode: nested tree", () => {
  const result = validateTreeNode.safeParse({
    value: "root",
    children: [
      { value: "child-1", children: [] },
      { value: "child-2", children: [{ value: "grandchild", children: [] }] },
    ],
  });
  log(`  success: ${result.success}`);
});

test("TreeNode: invalid child value", () => {
  const result = validateTreeNode.safeParse({
    value: "root",
    children: [{ value: 42, children: [] }],
  });
  log(`  success: ${result.success}`);
  if (!result.success) log(`  issues: ${result.error?.issues.length}`);
});

test("TreeNode: invalid children type", () => {
  const result = validateTreeNode.safeParse({ value: "root", children: "not array" });
  log(`  success: ${result.success}`);
});

// --- Inline compile (no intermediate variable) ---

test("Inline: valid", () => {
  const result = validateInline.safeParse({ id: "abc", value: 42 });
  log(`  success: ${result.success}`);
});

test("Inline: invalid (negative value)", () => {
  const result = validateInline.safeParse({ id: "abc", value: -1 });
  log(`  success: ${result.success}`);
  if (!result.success) log(`  issues: ${result.error?.issues.length}`);
});

log("\nAll tests completed.");
