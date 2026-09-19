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

import { createHash } from "node:crypto";
import { ArticleType, Prisma } from "@prisma/client";
import { prisma, withClearance } from "@/lib/db";
import { todayJst } from "@/lib/utils";
import { parseFrontmatterDate } from "@/lib/articles/frontmatter";
import { jpDate } from "@/lib/meetgreet/article";
import { MAX_ARTICLE_CLEARANCE } from "@/lib/meetgreet/config";
import { planAppend, isPureAppend, appendDiff } from "@/lib/meetgreet/append";
import { jsonStringArray } from "@/lib/meetgreet/config";
import type { RenderedSource } from "@/lib/meetgreet/article";
import type { ArticleMode, ArticlePreview } from "@/lib/meetgreet/types";
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

export type { ArticleMode, ArticlePreview };

/** プレビューした内容と保存する内容が同じかを見るための指紋 */
export function bodyDigest(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}


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
  classification: string;
  /** 「足さない」と決めたもののキー (#134) */
  articleExclusions: unknown;
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
      digest: bodyDigest(rendered.body),
      addedLines: [],
      newSources: rendered.sources,
      droppedByClearance: rendered.droppedByClearance,
      additions: [],
      excluded: [],
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

  const stored = jsonStringArray(meetGreet.articleExclusions);
  const planArgs = {
    existingBody: article.body,
    parts: rendered.parts,
    sources: rendered.sources,
    existingSources,
  };
  const plan = planAppend({ ...planArgs, excluded: stored });
  return {
    mode: "append",
    title: rendered.title,
    body: plan.body,
    digest: bodyDigest(plan.body),
    addedLines: appendDiff(article.body, plan.body).added,
    newSources: plan.newSources,
    droppedByClearance: rendered.droppedByClearance,
    additions: plan.additions,
    excluded: describeExclusions(stored, planArgs),
    empty: plan.empty,
    shortId: article.shortId,
  };
}

/**
 * 外しているものに名前をつける (戻す判断ができるように)。
 * 除外を当てずに組み直すと、外した当人が `additions` に現れるのでラベルが取れる。
 * ドシエから消えたものは候補に出てこないので、キーをそのまま見せる
 * (見えないまま残ると、同じものを足し直したいときに理由の分からない不在になる)。
 */
function describeExclusions(
  stored: readonly string[],
  planArgs: Omit<Parameters<typeof planAppend>[0], "excluded">
): { key: string; label: string }[] {
  if (stored.length === 0) return [];
  const labels = new Map(planAppend(planArgs).additions.map((a) => [a.key, a.label]));
  return stored.map((key) => ({ key, label: labels.get(key) ?? key }));
}

/** 「今後足さない」を取り消す。次のプレビューからまた候補に出る (#134) */
export async function restoreMeetGreetExclusions(
  user: ActingUser,
  meetGreet: MeetGreetForArticle,
  keys: readonly string[]
): Promise<number> {
  const stored = jsonStringArray(meetGreet.articleExclusions);
  const next = stored.filter((k) => !keys.includes(k));
  if (next.length === stored.length) return 0;
  await withClearance(user.clearance, (tx) =>
    tx.meetGreet.update({
      where: { id: meetGreet.id },
      data: { articleExclusions: next as unknown as Prisma.InputJsonValue },
    })
  );
  await logAudit({
    actorId: user.id,
    action: "meetgreet.article.restore",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: { restored: stored.length - next.length, keys: [...keys] },
  });
  return stored.length - next.length;
}

export type SaveArticleResult =
  | {
      ok: true;
      mode: ArticleMode;
      shortId: string;
      added: number;
      sources: number;
      /** 反映できなかった出典 (本文の ^[n] が宛先を失っている可能性がある) */
      failed: string[];
    }
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
 * 出典を順に作って反映する。
 *
 * **必ず本文を書く前に呼ぶこと。** `nextSourceNo` は既存行の番号だけでなく
 * **本文に書かれている `^[n]` の最大値**も見て +1 する (`src/lib/articles/apply.ts`)。
 * 先に本文を書くと、本文が `^[1..N]` を含むせいで行には `N+1..2N` が振られ、
 * **生成した記事の脚注が全部リンク切れになる**。
 *
 * `updatedAt` は apply のたびに進むので、返り値を次の呼び出しに渡して楽観ロックを繋ぐ
 * (途中で他の編集が入ったら conflict になる)。
 */
async function applySources(
  shortId: string,
  articleId: string,
  sources: RenderedSource[],
  user: ActingUser,
  actor: ArticleActor,
  expectedUpdatedAt: Date
): Promise<{ applied: number; failed: string[]; updatedAt: Date }> {
  let applied = 0;
  let stamp = expectedUpdatedAt;
  const failed: string[] = [];
  for (const s of sources) {
    if (!s.assetId) {
      failed.push(`${s.label} (紐づけ先のアセットが無い)`);
      continue;
    }
    const created = await addAssetToArticle(
      { articleId, assetId: s.assetId, label: s.label },
      user.clearance
    );
    const result = await applyArticleSource(
      {
        shortId,
        sourceId: created.id,
        expectedUpdatedAt: stamp,
        // 機械が集めた出典なので、公開に落とせる上限を API 経路と同じにする
        maxClassification: MAX_ARTICLE_CLEARANCE,
        actor,
      },
      user.clearance
    );
    if (result.ok) {
      applied++;
      stamp = result.updatedAt;
      // addAssetToArticle / applyArticleSource は url と date を持たない
      // (「捏造しない」方針)。組み立てで分かっているぶんはここで入れる。
      // 入れないと公開記事の脚注からブログへのリンクが消える
      if (s.url || s.date) {
        await withClearance(user.clearance, (tx) =>
          tx.articleSource.update({
            where: { id: created.id },
            data: {
              ...(s.url ? { url: s.url } : {}),
              ...(s.date ? { date: new Date(`${s.date}T00:00:00Z`) } : {}),
            },
          })
        );
      }
      // 予測した番号と実際に振られた番号がズレたら、本文の ^[n] が宛先を失う
      if (result.sourceNo !== s.sourceNo) {
        failed.push(`${s.label} (脚注番号が ${s.sourceNo} ではなく ${result.sourceNo} になった)`);
      }
    } else {
      failed.push(`${s.label} (${result.reason})`);
      if (result.reason === "conflict") break; // 以降は番号がずれるので続けない
    }
  }
  return { applied, failed, updatedAt: stamp };
}

/** frontmatter の dossier / meetgreet を入れ直す (push でそのまま復元される) */
/** 比較用に `dossier.synced_at` を落とす (取り込んだ日は中身の変化ではない) */
function withoutSyncedAt(extra: Record<string, unknown>): Record<string, unknown> {
  const dossier = extra.dossier;
  if (!dossier || typeof dossier !== "object" || Array.isArray(dossier)) return extra;
  const { synced_at: _drop, ...rest } = dossier as Record<string, unknown>;
  return { ...extra, dossier: rest };
}

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
  const next = { ...base, ...extra };
  // **実質同じなら書かない。** dirty は「DB の出力 ≠ GitHub」の意味なので、何も増えなかった
  // 保存のたびに立てると、`synced_at` の日付が動いただけの push が積まれる。
  // 「要反映」の判定に使うのは `item_count` と `updated_at` だけ (`loadNeedsSync`) なので、
  // `synced_at` の差は変化と見なさない (= 本当に取り込んだ日が残る)
  if (JSON.stringify(withoutSyncedAt(next)) === JSON.stringify(withoutSyncedAt(base))) return;
  await prisma.article.update({
    where: { id: articleId },
    // 直接書くので dirty / editedAt も自分で立てる (次の push に載せるため)
    data: {
      frontmatterExtra: next as Prisma.InputJsonValue,
      dirty: true,
      editedAt: new Date(),
    },
  });
}

/** 生成結果を保存する。新規なら作成、既存なら追記 */
export async function saveMeetGreetArticle(
  user: ActingUser,
  meetGreet: MeetGreetForArticle,
  /** 画面が見せたプレビューの指紋。渡すと、組み立て直した結果が変わっていたら中止する */
  expectedDigest?: string,
  /** 今回「足さない」と決めたもののキー。除外リストに追加してから組み立て直す (#134) */
  exclude: readonly string[] = []
): Promise<SaveArticleResult> {
  const actor: ArticleActor = { id: user.id };
  const rendered = await buildMeetGreetArticle(user, meetGreet);

  const mismatch = (body: string) =>
    expectedDigest !== undefined && bodyDigest(body) !== expectedDigest;

  // --- 新規作成 ---
  if (!meetGreet.articleId) {
    if (mismatch(rendered.body)) {
      return {
        ok: false,
        error: "内容が変わりました (素材が増減したか、TikTok の解決結果が変わりました)。もう一度差分を見てください",
      };
    }
    const today = todayJst();
    const created = await createArticle(
      {
        title: rendered.title,
        type: ArticleType.event,
        tags: rendered.tags,
        // **本文は後で入れる。** 出典の採番が本文の ^[n] を見るので、先に本文を入れると
        // 番号が本文の最大値の続きから振られてリンク切れになる
        body: "",
        date: meetGreet.date,
        publishedAt: today,
        articleUpdatedAt: today,
        // 既存のミーグリ記事は下書きではない
        draft: false,
      },
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
    const shortId = created.article.shortId;

    // **先に紐づける。** 出典や本文の書き込みで落ちたとき、記事だけできて MeetGreet に
    // 繋がっていないと、次の実行が path_exists で止まり手当てのしようがなくなる
    await withClearance(user.clearance, (tx) =>
      tx.meetGreet.update({ where: { id: meetGreet.id }, data: { articleId } })
    );

    // 1. 出典を反映して番号を確定させる (本文はまだ空なので 1, 2, … と振られる)
    const applied = await applySources(
      shortId,
      articleId,
      rendered.sources,
      user,
      actor,
      created.article.updatedAt
    );

    // 2. 確定した番号を前提に本文を入れる
    const written = await updateArticle(
      shortId,
      applied.updatedAt,
      {
        title: rendered.title,
        type: ArticleType.event,
        tags: rendered.tags,
        body: rendered.body,
        date: parseFrontmatterDate(meetGreet.date),
        // 既存のミーグリ記事はすべて date_display を持っている (generate.py も書いていた)
        dateDisplay: jpDate(meetGreet.date),
        dateMode: null,
        publishedAt: parseFrontmatterDate(today),
        articleUpdatedAt: parseFrontmatterDate(today),
        draft: false,
        unlisted: false,
        ongoing: false,
      },
      actor
    );
    if (!written.ok) {
      return {
        ok: false,
        error: `記事は作りましたが本文を書けませんでした (${written.reason})。/articles/${shortId} を確認してください`,
      };
    }

    await saveFrontmatterExtra(articleId, rendered.frontmatterExtra as unknown as Record<string, unknown>);

    await logAudit({
      actorId: user.id,
      action: "meetgreet.article.create",
      targetType: "MeetGreet",
      targetId: meetGreet.id,
      metadata: {
        articleId,
        shortId,
        sources: applied.applied,
        failed: applied.failed.length,
        dropped: rendered.droppedByClearance,
      },
    });
    return {
      ok: true,
      mode: "create",
      shortId,
      added: 0,
      sources: applied.applied,
      failed: applied.failed,
    };
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

  const stored = jsonStringArray(meetGreet.articleExclusions);
  const planArgs = {
    existingBody: article.body,
    parts: rendered.parts,
    sources: rendered.sources,
    existingSources,
  };

  // **指紋は「見せたときと同じ条件」で照合する。** 除外を足すと本文が変わるので、
  // 除外を当てる前の結果と突き合わせる (除外を渡せば照合をすり抜けられる、を防ぐ)
  const shown = planAppend({ ...planArgs, excluded: stored });
  if (mismatch(shown.body)) {
    return {
      ok: false,
      error: "内容が変わりました (素材が増減したか、記事が他で編集されました)。もう一度差分を見てください",
    };
  }

  const exclusions = [...new Set([...stored, ...exclude])];
  const plan = exclude.length > 0 ? planAppend({ ...planArgs, excluded: exclusions }) : shown;
  if (plan.empty) {
    // 全部外したケース。本文は変えないが、外した事実は覚える
    if (exclude.length > 0) {
      await withClearance(user.clearance, (tx) =>
        tx.meetGreet.update({
          where: { id: meetGreet.id },
          data: { articleExclusions: exclusions as unknown as Prisma.InputJsonValue },
        })
      );
    }
    // 本文が増えなくてもドシエは動いている (アイテム削除・抜粋の編集など)。
    // スナップショットを更新しないと「要反映」バッジが永久に消えない
    await saveFrontmatterExtra(meetGreet.articleId, { dossier: rendered.frontmatterExtra.dossier });
    return { ok: true, mode: "append", shortId: article.shortId, added: 0, sources: 0, failed: [] };
  }

  // **既存行が 1 行でも消えていたら適用しない。** 手で入れた ![rep] や文面の調整を守る最後の砦
  if (!isPureAppend(article.body, plan.body)) {
    return { ok: false, error: "既存の本文が変化するため中止しました (純粋な追記になりません)" };
  }

  // **出典が先。** 本文を先に書くと ^[n] の最大値の続きから番号が振られてリンク切れになる
  const applied = await applySources(
    article.shortId,
    meetGreet.articleId,
    plan.newSources,
    user,
    actor,
    article.updatedAt
  );

  const updated = await updateArticle(
    article.shortId,
    applied.updatedAt,
    {
      title: article.title,
      type: article.type,
      tags: Array.isArray(article.tags) ? (article.tags as string[]) : [],
      body: plan.body,
      date: article.date,
      dateDisplay: article.dateDisplay,
      dateMode: article.dateMode,
      publishedAt: article.publishedAt,
      // 本文を直したら更新日を今日にする (記事編集の慣習に合わせる)
      articleUpdatedAt: parseFrontmatterDate(todayJst()),
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

  // ドシエのスナップショットを今回の状態に更新する (要反映の判定に使う)
  await saveFrontmatterExtra(meetGreet.articleId, {
    dossier: rendered.frontmatterExtra.dossier,
  });

  // **除外を覚えるのは本文の保存に成功してから。** 先に書くと、衝突や純粋追記でない等で
  // 中止したときに「外した」だけが残り、戻す手段が無くなる
  if (exclude.length > 0) {
    await withClearance(user.clearance, (tx) =>
      tx.meetGreet.update({
        where: { id: meetGreet.id },
        data: { articleExclusions: exclusions as unknown as Prisma.InputJsonValue },
      })
    );
  }

  const added = appendDiff(article.body, plan.body).added.length;
  await logAudit({
    actorId: user.id,
    action: "meetgreet.article.append",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: {
      shortId: article.shortId,
      added,
      sources: applied.applied,
      failed: applied.failed.length,
      excluded: exclude,
      ...plan.added,
    },
  });
  return {
    ok: true,
    mode: "append",
    shortId: article.shortId,
    added,
    sources: applied.applied,
    failed: applied.failed,
  };
}
