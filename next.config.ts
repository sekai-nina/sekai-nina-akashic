import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "kuromoji"],
  typescript: {
    ignoreBuildErrors: true,
  },
  outputFileTracingIncludes: {
    "/api/v1/stats/words": ["./node_modules/kuromoji/dict/**/*"],
  },
  experimental: {
    staleTimes: {
      dynamic: 30, // 動的ページのクライアントキャッシュを30秒保持
    },
  },
};

export default nextConfig;
