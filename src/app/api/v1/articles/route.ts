import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { API_APPLY_MAX_CLASSIFICATION } from "@/lib/articles/apply";
import { ArticleCreateSchema } from "@/lib/articles/create";
import { ARTICLE_TYPES } from "@/lib/articles/frontmatter";
import { toArticleDetail, toArticleSummary } from "@/lib/domain/article-api";
import { createArticle, listArticles } from "@/lib/domain/articles";
import { formatZodError } from "@/lib/zod-error";
import type { ArticleType } from "@prisma/client";

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

/** 1 以上の整数に丸める。負数・小数・文字列は既定に倒す (Prisma に負の take を渡さない) */
function positiveInt(raw: string | null, fallback: number, max = Number.POSITIVE_INFINITY): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * 記事一覧。`hasPending=true` で「本文に未反映の紐づけがある記事」だけに絞れる
 * (AI エージェントが作業対象を探す入口)。pending の判定は API から apply できる範囲
 * (`API_APPLY_MAX_CLASSIFICATION` 以下) に揃える。
 */
export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const type = sp.get("type");
  if (type && !ARTICLE_TYPES.has(type)) {
    return NextResponse.json({ error: `type must be one of: ${[...ARTICLE_TYPES].join(", ")}` }, { status: 400 });
  }

  const result = await listArticles({
    clearance: auth.clearance,
    page: positiveInt(sp.get("page"), 1),
    perPage: positiveInt(sp.get("perPage"), DEFAULT_PER_PAGE, MAX_PER_PAGE),
    type: (type as ArticleType | null) ?? undefined,
    q: sp.get("q") ?? undefined,
    includeDraft: sp.get("includeDraft") !== "false",
    onlyPending: sp.get("hasPending") === "true",
    pendingMaxClassification: API_APPLY_MAX_CLASSIFICATION,
    onlyDirty: sp.get("dirty") === "true",
  });
  return NextResponse.json({
    items: result.items.map(toArticleSummary),
    total: result.total,
    page: result.page,
    perPage: result.perPage,
  });
}

/**
 * 記事の新規作成。`title` と `type` が必須、残りは PATCH と同じ項目を省略可 (`ArticleCreateSchema`)。
 *
 * - `shortId` / `path` はサーバが採番する (規則は `src/lib/articles/create.ts`)。同じ path の記事が
 *   あれば 409 で既存の `shortId` を返す (呼び出し側はそれを PATCH する)
 * - 省略時は `draft: true`、`publishedAt` / `articleUpdatedAt` は今日 (JST)
 * - 書いたら `dirty = true` / `editedAt = now`。次の push で新規ファイルとして公開リポジトリに載る
 *   (`draft` は公開サイトの記事ページに出さないだけで、**ファイル自体は公開される**)。
 *   監査ログは domain が書く
 * - 応答は GET /articles/:shortId と同じ形 (`sources` は空)。`updatedAt` は続けて PATCH するときの
 *   楽観ロックに使う
 *
 * PATCH と同じく revalidate はしない (記事ページにサーバ側キャッシュが無く、Route Handler からは
 * ブラウザの Router Cache も消せない)。
 */
export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ArticleCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const result = await createArticle(parsed.data, { id: auth.id, apiKeyId: auth.apiKeyId });
  if (!result.ok) {
    switch (result.reason) {
      case "invalid":
        return NextResponse.json(
          { error: "validation failed", reason: result.reason, fieldErrors: result.errors },
          { status: 400 },
        );
      case "invalid_path":
        // 日本語の理由は fieldErrors に入れ、`error` は他の REST と同じ英語にする
        return NextResponse.json(
          { error: "invalid title for path", reason: result.reason, fieldErrors: { title: result.error } },
          { status: 400 },
        );
      case "path_exists":
        // 既存の shortId と title を添えて、一覧を引き直さずに PATCH へ進めるようにする
        // (全角置換は多対一なので、別の記事を潰さないか呼び出し側が確かめられるようにする)
        return NextResponse.json(
          {
            error: `Article already exists at ${result.path}`,
            reason: result.reason,
            path: result.path,
            shortId: result.existingShortId,
            title: result.existingTitle,
          },
          { status: 409 },
        );
      case "path_exists_upstream":
        return NextResponse.json(
          {
            error: `A file already exists at ${result.path} in the articles repository but has not been imported`,
            reason: result.reason,
            path: result.path,
          },
          { status: 409 },
        );
    }
  }
  return NextResponse.json(toArticleDetail(result.article), { status: 201 });
}
