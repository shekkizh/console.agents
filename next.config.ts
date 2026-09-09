import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? (process.env.E2E_TEST_MODE === "1" ? ".next-e2e" : ".next"),
  serverExternalPackages: ["microsandbox"],
};

export default nextConfig;
