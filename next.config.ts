import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "172.1.5.16",
    "*.app.github.dev",
  ],
};

export default nextConfig;