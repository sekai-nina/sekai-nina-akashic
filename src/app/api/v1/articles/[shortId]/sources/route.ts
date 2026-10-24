import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { API_APPLY_MAX_CLASSIFICATION } from "@/lib/articles/apply";
import { ArticleSourceAddSchema } from "@/lib/articles/source";
import { toArticleSourceDetail } from "@/lib/domain/article-api";
import { addArticleSource } from "@/lib/domain/articles";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ shortId: string }> };

/**
 * アセット (と抜粋) を記事に紐づける (#110)。status は pending 固定で、公開されない。
 * 本文への反映は `POST /articles/:shortId/sources/:sourceId/apply` で脚注番号を採ってから行う。
 *
 * API キーからは `internal` 以下のアセットだけ紐づけられる (それより上は apply できず、記事詳細でも
 * 返さないので、ここで 403 にする)。pending の追加は push の出力に影響しないので `updatedAt` は進めない。
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { shortId } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ArticleSourceAddSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const result = await addArticleSource(
    {
      ...parsed.data,
      shortId,
      maxClassification: API_APPLY_MAX_CLASSIFICATION,
      actor: { id: auth.id, apiKeyId: auth.apiKeyId },
    },
    auth.clearance
  );
  if (!result.ok) {
    switch (result.reason) {
      case "article_not_found":
        return NextResponse.json({ error: "Article not found", reason: result.reason }, { status: 404 });
      case "asset_not_found":
        return NextResponse.json({ error: "Asset not found", reason: result.reason }, { status: 404 });
      case "above_limit":
        return NextResponse.json(
          {
            error: `Cannot link an asset classified above ${API_APPLY_MAX_CLASSIFICATION} via API key; link it from the UI`,
            reason: result.reason,
          },
          { status: 403 }
        );
    }
  }

  return NextResponse.json({ shortId, ...toArticleSourceDetail(result.source) }, { status: 201 });
}
