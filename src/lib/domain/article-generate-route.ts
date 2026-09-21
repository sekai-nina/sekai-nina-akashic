/**
 * `POST /api/v1/{meetgreets,lives,dossiers}/:id/article` の共通の本体 (#151)。
 *
 * 3 つの route は「器を引く」ところだけ違い、`restore` / `dryRun` / 保存の分岐と応答の形は同じ。
 * ここに寄せて、器が増えても route が 60 行のコピーにならないようにする。
 * JSON の読み取りと zod の検証、器の取得 (404) は route 側 (器ごとに違うため)。
 */

import { NextResponse } from "next/server";
import type { AiDraft } from "@/lib/article-workflow/templates";
import { previewArticle, restoreExclusions, saveArticle, type ArticleTarget } from "./article-generate";
import { WorkflowInputError, type ActingUser } from "./article-workflow";

export interface ArticleGenerateRequest {
  dryRun?: boolean;
  expectedDigest?: string;
  exclude?: string[];
  restore?: string[];
  aiDraft?: AiDraft | null;
}

/**
 * 記事を生成する。既存記事が紐づいていれば**増えた分だけ追記**、無ければ新規作成。
 * `dryRun: true` なら書き込まず、適用後の本文と増える行だけを返す。
 * `restore` だけを送ると、「今後足さない」の取り消しだけを行う (記事は触らない)。
 */
export async function handleArticleGenerate(
  user: ActingUser,
  target: ArticleTarget,
  input: ArticleGenerateRequest
): Promise<NextResponse> {
  try {
    // **`?.length` で見ない。** `restore: []` が偽になって保存に落ちる
    if (input.restore !== undefined) {
      const restored = await restoreExclusions(user, target, input.restore);
      return NextResponse.json({ restored });
    }
    if (input.dryRun) {
      const preview = await previewArticle(user, target, input.exclude ?? []);
      return NextResponse.json({
        mode: preview.mode,
        title: preview.title,
        body: preview.body,
        digest: preview.digest,
        addedLines: preview.addedLines,
        newSources: preview.newSources,
        droppedByClearance: preview.droppedByClearance,
        additions: preview.additions,
        excluded: preview.excluded,
        empty: preview.empty,
        shortId: preview.shortId,
        ai: preview.ai,
        aiDraft: preview.aiDraft,
      });
    }
    const result = await saveArticle(user, target, input.expectedDigest, input.exclude ?? [], input.aiDraft);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({
      mode: result.mode,
      shortId: result.shortId,
      added: result.added,
      sources: result.sources,
    });
  } catch (e) {
    return articleGenerateErrorResponse(e);
  }
}

/** 入力の不備 (器ごとの `*InputError` はすべて `WorkflowInputError`) は 400、権限不足は 403。それ以外は投げ直す (500) */
export function articleGenerateErrorResponse(e: unknown): NextResponse {
  if (e instanceof WorkflowInputError) return NextResponse.json({ error: e.message }, { status: 400 });
  if (e instanceof Error && e.message.includes("Access denied")) {
    return NextResponse.json({ error: e.message }, { status: 403 });
  }
  throw e;
}
