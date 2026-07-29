import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Console",
  description: "A private workspace for you and your managed agents.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const body = <body>{children}</body>;
  return (
    <html lang="en">
      {process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY ? <ClerkProvider>{body}</ClerkProvider> : body}
    </html>
  );
}
