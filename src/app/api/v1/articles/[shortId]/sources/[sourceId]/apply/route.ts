import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { API_APPLY_MAX_CLASSIFICATION } from "@/lib/articles/apply";
import { ArticleApplyRequestSchema, parseUpdatedAt } from "@/lib/articles/patch";
import { applyArticleSource } from "@/lib/domain/articles";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ shortId: string; sourceId: string }> };

/**
 * 紐づけ (pending) を「本文に反映済み」(applied) にする。**公開を決める操作。**
 *
 * applied と同時に classification が public に下がり、次の push で label / ref が
 * 公開リポジトリの frontmatter に載る。API キーからは `internal` 以下の出典しか公開化できない
 * (`docs/api.md` の「引き下げ不可」の例外。confidential 以上は画面から人間が行う)。
 *
 * 応答の `sourceNo` で本文に `^[n]` を書き、`updatedAt` を次の PATCH に渡す。
 * 409 は `reason` で区別する (`conflict` だけが「読み直して再試行」の対象)。
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { shortId, sourceId } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ArticleApplyRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  const expected = parseUpdatedAt(parsed.data.updatedAt);
  if (!expected) return NextResponse.json({ error: "updatedAt must be an ISO 8601 date-time" }, { status: 400 });

  const result = await applyArticleSource(
    {
      shortId,
      sourceId,
      expectedUpdatedAt: expected,
      maxClassification: API_APPLY_MAX_CLASSIFICATION,
      actor: { id: auth.id, apiKeyId: auth.apiKeyId },
    },
    auth.clearance,
  );
  if (!result.ok) {
    switch (result.reason) {
      case "not_found":
        return NextResponse.json({ error: "Article or source not found", reason: result.reason }, { status: 404 });
      case "not_pending":
        return NextResponse.json({ error: "Source is not pending", reason: result.reason }, { status: 409 });
      case "asset_missing":
        return NextResponse.json(
          { error: "Source has no asset (deleted after linking)", reason: result.reason },
          { status: 409 },
        );
      case "above_limit":
        return NextResponse.json(
          {
            error: `Cannot publish a source classified above ${API_APPLY_MAX_CLASSIFICATION} via API key; apply it from the UI`,
            reason: result.reason,
          },
          { status: 403 },
        );
      case "conflict":
        return NextResponse.json(
          { error: "Article was modified since it was read", reason: result.reason, updatedAt: result.currentUpdatedAt },
          { status: 409 },
        );
    }
  }

  return NextResponse.json({ shortId, sourceId, sourceNo: result.sourceNo, updatedAt: result.updatedAt });
}
