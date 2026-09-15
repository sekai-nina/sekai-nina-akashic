import type { NextConfig } from "next";

/**
 * 全経路に付けるセキュリティヘッダ。
 *
 * script-src の nonce 化はしていない。Next.js のインラインスクリプトを壊さずに
 * 入れるには middleware での nonce 発行と全 <Script> への引き回しが要り、
 * 影響範囲が大きいため別途。ここでは**壊れる余地が無く効果のあるもの**に絞る。
 *
 * akashic では XSS の被害が大きい (Supabase の認証 cookie は @supabase/ssr の
 * ブラウザクライアントが document.cookie で読む設計なので httpOnly ではない)。
 * 記事本文は rehype-sanitize で掃除しているが、多層防御としてこちらも置く。
 */
const SECURITY_HEADERS = [
  // <object> / <embed> 経由のスクリプト実行を塞ぐ
  { key: "Content-Security-Policy", value: "object-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
  // Content-Type の推測による実行を防ぐ
  { key: "X-Content-Type-Options", value: "nosniff" },
  // 外部への参照元漏れを抑える
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
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
