import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "zod-compiler Next.js Demo",
  description: "Testing zod-compiler with Next.js webpack integration",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
