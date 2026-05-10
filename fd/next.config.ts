import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  onDemandEntries: {
    maxInactiveAge: 25_000,
    pagesBufferLength: 2,
  },
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
