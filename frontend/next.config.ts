import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // Browsers often request /favicon.ico first; serve the app icon route.
      { source: "/favicon.ico", destination: "/icon.png" },
    ];
  },
};

export default nextConfig;
