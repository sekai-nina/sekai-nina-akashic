import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ARTICLE_PUSH_PERMISSION, ArticlePushRequestSchema } from "@/lib/articles/append";
import { parseUpdatedAt } from "@/lib/articles/patch";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/domain/audit";
import { pushDirtyArticles } from "@/lib/domain/articles";
import { GithubApiError, isGithubConfigured } from "@/lib/github/client";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ shortId: string }> };

/**
 * この記事 1 本だけを公開リポジトリに push する (#209)。`article_push` を持つキーだけ。
 *
 * - push 待ちでなければ何もしない (`pushed: 0`)
 * - `expectedUpdatedAt` (append の応答の `updatedAt`) を渡すと、それ以降に記事が編集されていたら
 *   push せず 409。bot が書いた直後に人が足した編集を、bot の push でまとめて出さない
 * - 衝突 (GitHub 側が先に変わっている) は書かずに `conflicts: 1` を返す。取り込み直してから押し直す
 * - GitHub の 422 (読んでから commit するまでにブランチが進んだ) は 409。少し待って再送すればよい
 *
 * `Article` は非保護テーブルなので存在確認は素の prisma
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, ARTICLE_PUSH_PERMISSION);
  if (auth instanceof NextResponse) return auth;
  if (!isGithubConfigured()) {
    return NextResponse.json({ error: "ARTICLES_GITHUB_TOKEN is not configured" }, { status: 503 });
  }

  const { shortId } = await params;
  let raw: unknown = {};
  try {
    const text = await request.text();
    if (text.trim()) raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ArticlePushRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  let expected: Date | null = null;
  if (parsed.data.expectedUpdatedAt) {
    expected = parseUpdatedAt(parsed.data.expectedUpdatedAt);
    if (!expected) {
      return NextResponse.json({ error: "expectedUpdatedAt must be an ISO 8601 date-time" }, { status: 400 });
    }
  }

  const article = await prisma.article.findUnique({ where: { shortId }, select: { updatedAt: true } });
  if (!article) return NextResponse.json({ error: "Article not found" }, { status: 404 });
  if (expected && article.updatedAt.getTime() !== expected.getTime()) {
    return NextResponse.json(
      { error: "Article was modified after the append; leaving it for a human to push", reason: "conflict", updatedAt: article.updatedAt },
      { status: 409 },
    );
  }

  try {
    const result = await pushDirtyArticles(parsed.data.subject ?? null, { shortId });
    if (result.commit) {
      await logAudit({
        actorId: auth.id,
        action: "article.push",
        targetType: "github_commit",
        targetId: result.commit.commitSha,
        metadata: {
          url: result.commit.url,
          shortId,
          apiKeyId: auth.apiKeyId,
          pushed: result.pushed,
          unchanged: result.unchanged,
          blocked: result.blocked,
          conflicts: result.conflicts,
          dbError: result.dbError,
        },
      });
    }
    return NextResponse.json({
      shortId,
      pushed: result.pushed,
      unchanged: result.unchanged,
      blocked: result.blocked,
      conflicts: result.conflicts,
      commitUrl: result.commit?.url ?? null,
      dbError: result.dbError,
    });
  } catch (e) {
    if (e instanceof GithubApiError) {
      if (e.status === 422) {
        return NextResponse.json(
          { error: "The branch moved while pushing; retry shortly", reason: "branch_moved" },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: `GitHub: ${e.message}` }, { status: 502 });
    }
    throw e;
  }
}
