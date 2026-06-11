import { AdminSchema } from "@/lib/admin";
import { LoginForm, LoginSchema } from "@/lib/login-form";
import { CreateUserSchema, ProductSchema } from "@/lib/schemas";

export default function Home() {
  const userResult = CreateUserSchema.safeParse({
    name: "Alice",
    email: "alice@example.com",
    age: 30,
    role: "admin",
  });

  const productResult = ProductSchema.safeParse({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "Widget",
    price: 9.99,
    tags: ["electronics"],
    inStock: true,
  });

  const loginResult = LoginSchema.safeParse({
    email: "user@example.com",
    password: "securepass",
  });

  const adminResult = AdminSchema.safeParse({
    role: "admin",
    reason: "test",
  });

  return (
    <main style={{ padding: "2rem", fontFamily: "monospace" }}>
      <h1>zod-compiler + Next.js (webpack)</h1>

      <section>
        <h2>User</h2>
        <pre>{JSON.stringify(userResult, null, 2)}</pre>
      </section>

      <section>
        <h2>Product</h2>
        <pre>{JSON.stringify(productResult, null, 2)}</pre>
      </section>

      <section>
        <h2>Login (JSX — skipped by autoDiscover)</h2>
        <LoginForm />
        <pre>{JSON.stringify(loginResult, null, 2)}</pre>
      </section>

      <section>
        <h2>Admin (path alias — skipped by autoDiscover)</h2>
        <pre>{JSON.stringify(adminResult, null, 2)}</pre>
      </section>
    </main>
  );
}
