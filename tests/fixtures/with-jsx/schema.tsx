import { z } from "zod";

export const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export function LoginForm() {
  return (
    <form>
      <input type="email" />
      <input type="password" />
      <button type="submit">Login</button>
    </form>
  );
}
