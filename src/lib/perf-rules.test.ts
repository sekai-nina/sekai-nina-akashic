import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * docs/performance.md のルールのうち、機械的に見張れるものを見張る。
 *
 * Server Action が revalidatePath / updateTag / refresh() を呼ぶと、Action の応答に画面の描き直しが入って返る。
 * そのうえでクライアントが router.refresh() を呼ぶと、同じ画面をもう一度描く (ボタン 1 回の待ちがほぼ倍)。
 * 2026-11 に 44 か所あったので外した。ここに無いファイルで router.refresh() を書くとこのテストが落ちる。
 *
 * 1 ファイル 1 本まで。足してよいのは「Action を経由しない (fetch で API を叩いた後・ログイン直後) か、Action が描き直しを
 * 返さない経路がある」ときだけ。理由を添えて下の表に足す。Action の後なら、まず Action の中で
 * `refresh()` (next/cache) を呼べないか考える。
 */
const ROUTER_REFRESH_ALLOWED: Record<string, string> = {
  "src/app/(auth)/login/page.tsx": "ログイン直後に cookie を読み直す",
  "src/app/(auth)/mfa/setup/page.tsx": "MFA 登録直後に cookie を読み直す",
  "src/app/(auth)/mfa/verify/page.tsx": "MFA 検証直後に cookie を読み直す",
  "src/components/sidebar.tsx": "ログアウト後",
  "src/app/(main)/admin/sketch/style-upload.tsx": "fetch で API を叩いた後",
  "src/app/(main)/dossiers/[id]/external-image-form.tsx": "fetch で API を叩いた後",
  "src/app/(main)/assets/new/page.tsx": "fetch で API を叩いた後",
  "src/components/quick-upload-form.tsx": "fetch で API を叩いた後",
  "src/components/workflow/sketch-step.tsx": "fetch で API を叩いた後 (参照画像の削除)",
  "src/components/workflow/ref-upload.tsx": "fetch で API を叩いた後",
  "src/app/(main)/articles/[shortId]/article-dossier.tsx": "企画が既にあったとき Action は描き直しを返さない",
  "src/app/(main)/repo/[id]/repo-curation.tsx": "取得の失敗時も一覧を読み直す (Action は成功時だけ revalidate)",
  "src/app/(main)/repo/new-collection-form.tsx": "取得の失敗時も一覧を読み直す (Action は成功時だけ revalidate)",
  "src/components/workflow/reports-step.tsx": "通信エラーで Action が revalidate しない経路がある",
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const root = join(__dirname, "../..");

/** コメントの行を除いて router.refresh() を数える。`useRouter().refresh()` や別名の router は拾わない (取りこぼしは許容) */
function countRouterRefresh(source: string): number {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .reduce((n, line) => n + (line.match(/\brouter\.refresh\(\)/g)?.length ?? 0), 0);
}

describe("パフォーマンスのルール (docs/performance.md)", () => {
  const counts = Object.fromEntries(
    walk(join(root, "src"))
      .map((path) => [relative(root, path), countRouterRefresh(readFileSync(path, "utf8"))] as const)
      .filter(([, n]) => n > 0),
  );

  it("router.refresh() は理由のある場所にだけ書く", () => {
    // 許可したファイルでも、本数が増えたら落とす (同じファイルに Action の後の refresh を足すのを防ぐ)
    const unexpected = Object.entries(counts)
      .filter(([path, n]) => n > (ROUTER_REFRESH_ALLOWED[path] ? 1 : 0))
      .map(([path, n]) => `${path} (${n} 本)`);
    expect(
      unexpected,
      "Server Action の後の router.refresh() は同じ画面を 2 回描く。docs/performance.md の 1. を読み、要るなら理由を添えて ROUTER_REFRESH_ALLOWED に足す",
    ).toEqual([]);
  });

  it("許可の表に、もう router.refresh() を呼ばないファイルを残さない", () => {
    const stale = Object.keys(ROUTER_REFRESH_ALLOWED).filter((path) => !counts[path]);
    expect(stale, "router.refresh() を消したら ROUTER_REFRESH_ALLOWED からも消す").toEqual([]);
  });
});
