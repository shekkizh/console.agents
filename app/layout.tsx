import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { config } from "@/lib/server/config";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Console",
  description: "Private persistent agents",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const document = (
    <html className="dark font-sans" lang="en" suppressHydrationWarning>
      <body><TooltipProvider>{children}</TooltipProvider></body>
    </html>
  );
  return config.e2eTestMode ? document : <ClerkProvider>{document}</ClerkProvider>;
}
