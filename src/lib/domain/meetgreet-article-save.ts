/**
 * 生成した記事の保存 (#109)。
 *
 * 組み立て (`meetgreet-article.ts`) と追記の計算 (`lib/meetgreet/append.ts`) は純粋関数で、
 * ここが DB への反映を受け持つ。記事まわりの既存の仕組み (`createArticle` /
 * `updateArticle` / `applyArticleSource`) をそのまま使う。
 *
 * **出典は `applyArticleSource` を順に呼ぶ。** この関数が `sourceNo` を max+1 で採るので、
 * 組み立てた順に呼べば本文の `^[n]` と一致する。直接 INSERT しないことで、
 * classification のガード (公開してよい機密レベルの上限) も効いたままになる。
 */

import { ArticleType, Prisma } from "@prisma/client";
import { prisma, withClearance } from "@/lib/db";
import { todayJst } from "@/lib/utils";
import { MAX_ARTICLE_CLEARANCE } from "@/lib/meetgreet/config";
import { planAppend, isPureAppend, appendDiff } from "@/lib/meetgreet/append";
import type { RenderedSource } from "@/lib/meetgreet/article";
import {
  addAssetToArticle,
  applyArticleSource,
  createArticle,
  updateArticle,
  type ArticleActor,
} from "./articles";
import { buildMeetGreetArticle } from "./meetgreet-article";
import { MeetGreetInputError, type ActingUser } from "./meetgreets";
import { logAudit } from "./audit";

export type ArticleMode = "create" | "append";

export interface MeetGreetForArticle {
  id: string;
  date: string;
  format: "online" | "real";
  venue: string | null;
  label: string;
  single: string;
  dossierId: string;
  repoCollectionId: string | null;
  sketchKey: string | null;
  articleId: string | null;
}

export interface ArticlePreview {
  mode: ArticleMode;
  title: string;
  /** 適用後の本文 */
  body: string;
  /** 追記のとき、増えた行の位置 (0 始まり) */
  addedLines: number[];
  /** 追加される出典 */
  newSources: RenderedSource[];
  /** 機密レベルで本文に載せなかったアセットの数 */
  droppedByClearance: number;
  /** 何も増えない */
  empty: boolean;
  /** 既存記事がある場合の shortId */
  shortId: string | null;
}

/**
 * 生成結果を見せる (DB には書かない)。
 * 既存記事があれば追記の差分、無ければ新規作成の本文を返す。
 */
export async function previewMeetGreetArticle(
  user: ActingUser,
  meetGreet: MeetGreetForArticle
): Promise<ArticlePreview> {
  const rendered = await buildMeetGreetArticle(user, meetGreet);

  if (!meetGreet.articleId) {
    return {
      mode: "create",
      title: rendered.title,
      body: rendered.body,
      addedLines: [],
      newSources: rendered.sources,
      droppedByClearance: rendered.droppedByClearance,
      empty: false,
      shortId: null,
    };
  }

  const article = await prisma.article.findUnique({
    where: { id: meetGreet.articleId },
    select: { shortId: true, body: true },
  });
  if (!article) throw new MeetGreetInputError("紐づいている記事が見つかりません");
  const existingSources = await loadArticleSources(user, meetGreet.articleId);

  const plan = planAppend({
    existingBody: article.body,
    parts: rendered.parts,
    sources: rendered.sources,
    existingSources,
  });
  return {
    mode: "append",
    title: rendered.title,
    body: plan.body,
    addedLines: appendDiff(article.body, plan.body).added,
    newSources: plan.newSources,
    droppedByClearance: rendered.droppedByClearance,
    empty: plan.empty,
    shortId: article.shortId,
  };
}

export type SaveArticleResult =
  | { ok: true; mode: ArticleMode; shortId: string; added: number; sources: number }
  | { ok: false; error: string };

/**
 * 既存の出典を読む。
 * **`ArticleSource` は保護テーブル**なので、`prisma.article` の入れ子で引くと
 * 無言で空配列になる (= 既存の脚注番号を見落として 1 から振り直してしまう)。
 */
async function loadArticleSources(user: ActingUser, articleId: string) {
  return withClearance(user.clearance, (tx) =>
    tx.articleSource.findMany({
      where: { articleId },
      select: { sourceNo: true, assetId: true, url: true },
    })
  );
}

/**
 * 出典を順に作って反映する。`applyArticleSource` が採る `sourceNo` が
 * 組み立て順どおり 1, 2, … になるので、本文の `^[n]` と一致する。
 */
async function applySources(
  shortId: string,
  articleId: string,
  sources: RenderedSource[],
  user: ActingUser,
  actor: ArticleActor
): Promise<number> {
  let applied = 0;
  for (const s of sources) {
    if (!s.assetId) continue; // ref の無い出典は作れない
    const created = await addAssetToArticle(
      { articleId, assetId: s.assetId, label: s.label },
      user.clearance
    );
    // 直前の状態を読んでから apply する (apply 自体が updatedAt を進めるため毎回読み直す)
    const current = await prisma.article.findUnique({
      where: { shortId },
      select: { updatedAt: true },
    });
    if (!current) break;
    const result = await applyArticleSource(
      {
        shortId,
        sourceId: created.id,
        expectedUpdatedAt: current.updatedAt,
        // 機械が集めた出典なので、公開に落とせる上限を API 経路と同じにする
        maxClassification: MAX_ARTICLE_CLEARANCE,
        actor,
      },
      user.clearance
    );
    if (result.ok) applied++;
  }
  return applied;
}

/** frontmatter の dossier / meetgreet を入れ直す (push でそのまま復元される) */
async function saveFrontmatterExtra(
  articleId: string,
  extra: Record<string, unknown>
): Promise<void> {
  const current = await prisma.article.findUnique({
    where: { id: articleId },
    select: { frontmatterExtra: true },
  });
  const base =
    current?.frontmatterExtra && typeof current.frontmatterExtra === "object" && !Array.isArray(current.frontmatterExtra)
      ? (current.frontmatterExtra as Record<string, unknown>)
      : {};
  await prisma.article.update({
    where: { id: articleId },
    // 直接書くので dirty / editedAt も自分で立てる (次の push に載せるため)
    data: {
      frontmatterExtra: { ...base, ...extra } as Prisma.InputJsonValue,
      dirty: true,
      editedAt: new Date(),
    },
  });
}

/** 生成結果を保存する。新規なら作成、既存なら追記 */
export async function saveMeetGreetArticle(
  user: ActingUser,
  meetGreet: MeetGreetForArticle
): Promise<SaveArticleResult> {
  const actor: ArticleActor = { id: user.id };
  const rendered = await buildMeetGreetArticle(user, meetGreet);

  // --- 新規作成 ---
  if (!meetGreet.articleId) {
    const today = todayJst();
    const created = await createArticle(
      {
        title: rendered.title,
        type: ArticleType.event,
        tags: rendered.tags,
        body: rendered.body,
        date: meetGreet.date,
        publishedAt: today,
        articleUpdatedAt: today,
        // 既存のミーグリ記事は下書きではない
        draft: false,
      } as Parameters<typeof createArticle>[0],
      actor
    );
    if (!created.ok) {
      const message =
        created.reason === "path_exists"
          ? `同じ名前の記事が既にあります (${created.existingTitle})。その記事に紐づけてから追記してください`
          : created.reason === "path_exists_upstream"
            ? `公開リポジトリに同じ名前のファイルがあります (${created.path})。先に取り込んでください`
            : created.reason === "invalid_path"
              ? created.error
              : Object.values(created.errors).join(" / ");
      return { ok: false, error: message };
    }

    const articleId = created.article.id;
    await saveFrontmatterExtra(articleId, rendered.frontmatterExtra as unknown as Record<string, unknown>);
    const sources = await applySources(created.article.shortId, articleId, rendered.sources, user, actor);
    // MeetGreet は保護テーブル。素の prisma だと無言で 0 行になり、紐づけが付かない
    await withClearance(user.clearance, (tx) =>
      tx.meetGreet.update({ where: { id: meetGreet.id }, data: { articleId } })
    );

    await logAudit({
      actorId: user.id,
      action: "meetgreet.article.create",
      targetType: "MeetGreet",
      targetId: meetGreet.id,
      metadata: { articleId, shortId: created.article.shortId, sources, dropped: rendered.droppedByClearance },
    });
    return { ok: true, mode: "create", shortId: created.article.shortId, added: 0, sources };
  }

  // --- 追記 ---
  const article = await prisma.article.findUnique({
    where: { id: meetGreet.articleId },
    select: {
      shortId: true,
      body: true,
      updatedAt: true,
      title: true,
      type: true,
      tags: true,
      date: true,
      dateDisplay: true,
      dateMode: true,
      publishedAt: true,
      articleUpdatedAt: true,
      draft: true,
      unlisted: true,
      ongoing: true,
    },
  });
  if (!article) return { ok: false, error: "紐づいている記事が見つかりません" };
  const existingSources = await loadArticleSources(user, meetGreet.articleId);

  const plan = planAppend({
    existingBody: article.body,
    parts: rendered.parts,
    sources: rendered.sources,
    existingSources,
  });
  if (plan.empty) return { ok: true, mode: "append", shortId: article.shortId, added: 0, sources: 0 };

  // **既存行が 1 行でも消えていたら適用しない。** 手で入れた ![rep] や文面の調整を守る最後の砦
  if (!isPureAppend(article.body, plan.body)) {
    return { ok: false, error: "既存の本文が変化するため中止しました (純粋な追記になりません)" };
  }

  const updated = await updateArticle(
    article.shortId,
    article.updatedAt,
    {
      title: article.title,
      type: article.type,
      tags: Array.isArray(article.tags) ? (article.tags as string[]) : [],
      body: plan.body,
      date: article.date,
      dateDisplay: article.dateDisplay,
      dateMode: article.dateMode,
      publishedAt: article.publishedAt,
      articleUpdatedAt: article.articleUpdatedAt,
      draft: article.draft,
      unlisted: article.unlisted,
      ongoing: article.ongoing,
    },
    actor
  );
  if (!updated.ok) {
    return {
      ok: false,
      error: updated.reason === "conflict" ? "記事が他で更新されました。読み直してからやり直してください" : "記事が見つかりません",
    };
  }

  const sources = await applySources(article.shortId, meetGreet.articleId, plan.newSources, user, actor);
  // ドシエのスナップショットを今回の状態に更新する (要反映の判定に使う)
  await saveFrontmatterExtra(meetGreet.articleId, {
    dossier: rendered.frontmatterExtra.dossier,
  });

  const added = appendDiff(article.body, plan.body).added.length;
  await logAudit({
    actorId: user.id,
    action: "meetgreet.article.append",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: { shortId: article.shortId, added, sources, ...plan.added },
  });
  return { ok: true, mode: "append", shortId: article.shortId, added, sources };
}
