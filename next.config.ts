import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      { source: "/health", destination: "/api/health" },
      { source: "/staff", destination: "/api/staff" },
      { source: "/staff/:path*", destination: "/api/staff/:path*" },
      { source: "/services", destination: "/api/services" },
      { source: "/availability", destination: "/api/availability" },
      { source: "/notifications", destination: "/api/notifications" },
      { source: "/notifications/:path*", destination: "/api/notifications/:path*" },
      { source: "/otp/:path*", destination: "/api/otp/:path*" },
      { source: "/bookings", destination: "/api/bookings" },
      { source: "/bookings/:path*", destination: "/api/bookings/:path*" },
      { source: "/promo-codes/:path*", destination: "/api/promo-codes/:path*" },
      { source: "/payments", destination: "/api/payments" },
      { source: "/payments/:path*", destination: "/api/payments/:path*" },
      { source: "/auth/:path*", destination: "/api/auth/:path*" },
      { source: "/admin/:path*", destination: "/api/admin/:path*" },
    ];
  },
};

export default nextConfig;
