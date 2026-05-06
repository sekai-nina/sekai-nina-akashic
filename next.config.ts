import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "kuromoji", "sharp"],
  typescript: {
    ignoreBuildErrors: true,
  },
  outputFileTracingIncludes: {
    "/api/v1/stats/words": ["./data/kuromoji-dict/**/*"],
  },
  experimental: {
    staleTimes: {
      dynamic: 30, // 動的ページのクライアントキャッシュを30秒保持
    },
  },
};

export default nextConfig;
