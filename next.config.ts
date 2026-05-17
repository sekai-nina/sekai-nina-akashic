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
      dynamic: 300, // 動的ページのクライアントキャッシュを5分保持
      static: 600,
    },
    optimizePackageImports: ["lucide-react", "recharts", "leaflet", "react-leaflet"],
  },
};

export default nextConfig;
