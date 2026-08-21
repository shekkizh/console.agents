import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { config } from "@/lib/server/config";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Console",
  description: "Private persistent agents",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const document = (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
  return config.e2eTestMode ? document : <ClerkProvider>{document}</ClerkProvider>;
}
