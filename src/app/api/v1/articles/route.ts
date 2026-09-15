import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { API_APPLY_MAX_CLASSIFICATION } from "@/lib/articles/apply";
import { ARTICLE_TYPES } from "@/lib/articles/frontmatter";
import { toArticleSummary } from "@/lib/domain/article-api";
import { listArticles } from "@/lib/domain/articles";
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
