import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ArticleAppendRequestSchema } from "@/lib/articles/append";
import { API_APPLY_MAX_CLASSIFICATION } from "@/lib/articles/apply";
import { parseUpdatedAt } from "@/lib/articles/patch";
import { appendToArticle } from "@/lib/domain/articles";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ shortId: string }> };

/**
 * 本文を置き換えて出典を足す (#209)。Discord bot が一覧記事に 1 行足すのに使う。
 * 本文と出典は 1 トランザクションで書き、記事は push 待ちになる。公開は `POST /articles/:shortId/push`
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
  const parsed = ArticleAppendRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  const { updatedAt, ...input } = parsed.data;
  const expected = parseUpdatedAt(updatedAt);
  if (!expected) return NextResponse.json({ error: "updatedAt must be an ISO 8601 date-time" }, { status: 400 });

  const result = await appendToArticle(
    {
      shortId,
      expectedUpdatedAt: expected,
      ...input,
      actor: { id: auth.id, apiKeyId: auth.apiKeyId },
      maxClassification: API_APPLY_MAX_CLASSIFICATION,
    },
    auth.clearance,
  );
  if (!result.ok) {
    switch (result.reason) {
      case "not_found":
        return NextResponse.json({ error: "Article not found" }, { status: 404 });
      case "asset_not_found":
        return NextResponse.json({ error: `Asset not found or not accessible: ${result.assetId}` }, { status: 400 });
      case "above_limit":
        return NextResponse.json(
          { error: `Asset is above ${API_APPLY_MAX_CLASSIFICATION} and cannot be a public source via API: ${result.assetId}` },
          { status: 403 },
        );
      case "invalid":
        return NextResponse.json({ error: "validation failed", fieldErrors: result.errors }, { status: 400 });
      case "conflict":
        return NextResponse.json(
          { error: "Article was modified since it was read", reason: "conflict", updatedAt: result.currentUpdatedAt },
          { status: 409 },
        );
    }
  }

  return NextResponse.json({
    shortId,
    changed: result.changed,
    addedSources: result.addedSources,
    hadPendingEdits: result.hadPendingEdits,
    updatedAt: result.updatedAt,
  });
}
