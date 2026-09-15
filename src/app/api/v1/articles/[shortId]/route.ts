import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ArticleUpdateRequestSchema, hasPatchFields, parseUpdatedAt } from "@/lib/articles/patch";
import { toArticleDetail } from "@/lib/domain/article-api";
import { getArticleByShortId, patchArticle } from "@/lib/domain/articles";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ shortId: string }> };

export async function GET(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { shortId } = await params;
  const article = await getArticleByShortId(shortId, auth.clearance);
  if (!article) return NextResponse.json({ error: "Article not found" }, { status: 404 });
  return NextResponse.json(toArticleDetail(article));
}

/**
 * 記事の部分更新。編集 UI と同じ 12 項目を省略可で受ける (`ArticleEditPatchSchema`)。
 *
 * - `updatedAt` (GET が返した ISO) は必須。一致しなければ 409 で現在の `updatedAt` を返す
 *   (呼び出し側は読み直して作り直す)。push は `updatedAt` を動かさないので、push を挟んでも通る
 * - 変わっていなければ書かない (dirty / editedAt も立てない)。応答の `changed` が空
 * - 書いたら `Article.dirty = true` / `editedAt = now` (規約)。次の push に載る。監査ログは domain が書く
 *
 * 記事ページは cookie 依存の動的描画でサーバ側キャッシュが無く、Route Handler からは
 * ブラウザの Router Cache も消せないので、ここでは revalidate しない (Server Action 側だけ)。
 */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { shortId } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ArticleUpdateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  const { updatedAt, ...patch } = parsed.data;
  const expected = parseUpdatedAt(updatedAt);
  if (!expected) return NextResponse.json({ error: "updatedAt must be an ISO 8601 date-time" }, { status: 400 });
  if (!hasPatchFields(patch)) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  const result = await patchArticle(shortId, expected, patch, { id: auth.id, apiKeyId: auth.apiKeyId });
  if (!result.ok) {
    switch (result.reason) {
      case "not_found":
        return NextResponse.json({ error: "Article not found" }, { status: 404 });
      case "invalid":
        return NextResponse.json({ error: "validation failed", fieldErrors: result.errors }, { status: 400 });
      case "conflict":
        // 現在の updatedAt を添えて、読み直しを 1 往復で済ませる
        return NextResponse.json(
          { error: "Article was modified since it was read", reason: "conflict", updatedAt: result.currentUpdatedAt },
          { status: 409 },
        );
    }
  }

  return NextResponse.json({ shortId, changed: result.changed, updatedAt: result.updatedAt });
}
