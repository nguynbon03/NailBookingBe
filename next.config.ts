import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      { source: "/health", destination: "/api/health" },
      { source: "/staff", destination: "/api/staff" },
      { source: "/bookings", destination: "/api/bookings" },
      { source: "/auth/:path*", destination: "/api/auth/:path*" },
      { source: "/admin/:path*", destination: "/api/admin/:path*" },
    ];
  },
};

export default nextConfig;
