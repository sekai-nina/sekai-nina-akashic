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

/** ffmpeg-static のバイナリ。pnpm の実体 (.pnpm 配下) と普通の配置の両方を書く */
const FFMPEG_FILES = [
  "./node_modules/.pnpm/ffmpeg-static*/node_modules/ffmpeg-static/ffmpeg",
  "./node_modules/ffmpeg-static/ffmpeg",
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
    /**
     * ffmpeg-static のバイナリ。`require("ffmpeg-static")` が返すのは実行時に組み立てる
     * パスなので、**自動追跡には乗らない**。入れ忘れた経路では実行時に ENOENT で落ちる。
     *
     * story の動画は「DASH の結合」「サムネイルのコマ抜き」「Discord 用の H.264 変換」で
     * ffmpeg を使い、**どれも登録の経路 (media-urls / result) で走る** (#206)。
     * complete にだけ入れていたせいで、本番では一度も変換できていなかった。
     * 経路を増やしたらここにも足す。
     */
    ...Object.fromEntries(
      [
        "/api/v1/insta/media-urls",
        "/api/v1/insta/jobs/[id]/media-urls",
        "/api/v1/insta/jobs/[id]/result",
        "/api/v1/insta/jobs/[id]/complete",
        "/api/v1/insta/diagnostics",
        "/api/cron/insta-jobs",
        // 「キューを進める」の Server Action はページ側のバンドルに入る
        "/admin/insta",
      ].map((route) => [route, FFMPEG_FILES]),
    ),
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
