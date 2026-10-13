/**
 * 番組 (ひなあい / まだまだ / ひななり) → 記事の進捗 (#208)。`/progress/<番組のキー>` の裏側。
 *
 * 1 回 (回番号) ごとに反映先が 2 つ:
 * - **出演一覧の行** (`list_row`): 出演一覧の記事に行があれば済 (導出)。対象外 = 出ていない回 (回ごと外す)
 * - **記事化** (`articles`): その回の動画を出典にした記事を並べる。「もう書くことが無い」は記事から
 *   分からないので、済は人が付ける
 *
 * 人が決めた状態は `ArticleProgress` (`materialKind=番組のキー`, `materialKey=回番号`)。
 * `Article` は非保護なので素の `prisma`、`Asset` / `ArticleSource` / `ArticleProgress` は `withClearance`。
 */

import type { ClearanceLevel, ProgressStatus, ProgressTarget } from "@prisma/client";
import { prisma, withClearance } from "@/lib/db";
import { accessibleClassifications, assertClearance } from "@/lib/classification";
import { episodeOf, isListTitle, listedEpisodes, SHOWS, subtitleOf, type ShowKey } from "@/lib/progress/shows";
import { insertListRow, nextSuffix, pickYearArticle } from "@/lib/progress/list-row";
import { isGithubConfigured } from "@/lib/github/client";
import { todayJst, toJstDateOnly } from "@/lib/utils";
import { API_APPLY_MAX_CLASSIFICATION } from "@/lib/articles/apply";
import { appendToArticle, pushDirtyArticles } from "./articles";
import { WorkflowInputError, type ActingUser } from "./article-workflow";
import { logAudit } from "./audit";

export class ProgressInputError extends WorkflowInputError {}

/** 低い順 (public が先) */
const LEVELS = accessibleClassifications("restricted");

export type TargetStatus = "done" | "excluded" | "todo";
/** 回全体の状態 (一覧の絞り込み用) */
export type EpisodeStatus = "todo" | "partial" | "done" | "excluded";

export interface ShowVideo {
  assetId: string;
  title: string;
  /** 題の【】の中 (動画ごとに違う。番外編は本編と別の副題になる) */
  subtitle: string;
  /** 出演一覧の行のタイトルの既定値。Lemino の企画名、無ければ副題 */
  listTitle: string;
  /** 本編以外 (番外編) */
  extra: boolean;
}

export interface CitingArticle {
  shortId: string;
  title: string;
  type: string | null;
}

export interface ShowEpisodeRow {
  episode: number;
  /** 放送日 (JST)。動画アセットの日付 */
  date: string | null;
  title: string;
  videos: ShowVideo[];
  status: EpisodeStatus;
  listRow: { status: TargetStatus; article: { shortId: string; title: string } | null; note: string };
  articles: { status: TargetStatus; items: CitingArticle[]; note: string };
}

interface Episode {
  episode: number;
  date: string | null;
  title: string;
  videos: ShowVideo[];
  /** 行の機密レベル。回の動画のうち最も低いもの (= 回が見える人なら誰でも見える) */
  classification: ClearanceLevel;
  assetIds: string[];
  urls: string[];
}

/** Lemino の収集が SourceRecord.metadata に入れる企画名 (`kikaku`)。bot の 📤 も出演一覧のタイトルにこれを使う */
function leminoKikaku(records: { url: string | null; metadata: unknown }[]): string | null {
  for (const r of records) {
    if (!r.url?.includes("lemino.docomo.ne.jp")) continue;
    const k = (r.metadata as { kikaku?: unknown } | null)?.kikaku;
    if (typeof k === "string" && k.trim()) return k.trim();
  }
  return null;
}

/** `only` を渡すとその回の動画だけを読む (ボタン 1 回ごとに全回を読まない) */
async function loadEpisodes(user: ActingUser, showKey: ShowKey, only?: number): Promise<Map<number, Episode>> {
  const show = SHOWS[showKey];
  const assets = await withClearance(user.clearance, (tx) =>
    tx.asset.findMany({
      where: {
        kind: "video",
        title: { contains: show.titleMarker },
        ...(show.excludeMarker ? { NOT: { title: { contains: show.excludeMarker } } } : {}),
        // 題の末尾に改行が付いたものがあるので endsWith ではなく contains (回番号は下で照合)
        ...(only === undefined ? {} : { AND: [{ title: { contains: `#${only}` } }] }),
      },
      select: {
        id: true,
        title: true,
        canonicalDate: true,
        classification: true,
        sourceRecords: { select: { url: true, metadata: true } },
      },
    })
  );
  const episodes = new Map<number, Episode>();
  for (const a of assets) {
    const n = episodeOf(show, a.title);
    if (n === null || (only !== undefined && n !== only)) continue;
    const ep = episodes.get(n) ?? {
      episode: n,
      date: null,
      title: "",
      videos: [],
      classification: a.classification,
      assetIds: [],
      urls: [],
    };
    const extra = show.isExtra(a.title);
    const subtitle = subtitleOf(a.title.trim());
    ep.videos.push({ assetId: a.id, title: a.title, subtitle, listTitle: leminoKikaku(a.sourceRecords) ?? subtitle, extra });
    ep.assetIds.push(a.id);
    for (const s of a.sourceRecords) if (s.url) ep.urls.push(s.url);
    const date = toJstDateOnly(a.canonicalDate);
    if (date && (!ep.date || date < ep.date)) ep.date = date;
    // 題は本編を優先 (番外編は副題が別になる)
    if (!extra || !ep.title) ep.title = subtitleOf(a.title);
    if (LEVELS.indexOf(a.classification) < LEVELS.indexOf(ep.classification)) ep.classification = a.classification;
    episodes.set(n, ep);
  }
  for (const ep of episodes.values()) ep.videos.sort((x, y) => Number(x.extra) - Number(y.extra));
  return episodes;
}

export async function listShowProgress(user: ActingUser, showKey: ShowKey): Promise<ShowEpisodeRow[]> {
  const show = SHOWS[showKey];
  const episodes = await loadEpisodes(user, showKey);
  const all = [...episodes.values()];
  const epByAsset = new Map(all.flatMap((e) => e.assetIds.map((id) => [id, e.episode] as const)));
  const epByUrl = new Map(all.flatMap((e) => e.urls.map((u) => [u, e.episode] as const)));

  const [lists, sources, progress] = await Promise.all([
    prisma.article.findMany({
      where: { title: { endsWith: show.listTitleSuffix } },
      select: { shortId: true, title: true, body: true },
    }),
    withClearance(user.clearance, (tx) =>
      tx.articleSource.findMany({
        where: { OR: [{ assetId: { in: [...epByAsset.keys()] } }, { url: { in: [...epByUrl.keys()] } }] },
        select: { assetId: true, url: true, article: { select: { shortId: true, title: true, type: true } } },
      })
    ),
    withClearance(user.clearance, (tx) =>
      tx.articleProgress.findMany({
        where: { materialKind: showKey },
        select: { materialKey: true, target: true, status: true, note: true },
      })
    ),
  ]);

  const listByEpisode = new Map<number, { shortId: string; title: string }>();
  for (const l of lists) {
    if (!isListTitle(show, l.title)) continue;
    for (const n of listedEpisodes(l.body)) if (!listByEpisode.has(n)) listByEpisode.set(n, { shortId: l.shortId, title: l.title });
  }

  const citing = new Map<number, Map<string, CitingArticle>>();
  for (const s of sources) {
    if (isListTitle(show, s.article.title)) continue;
    const n = (s.assetId ? epByAsset.get(s.assetId) : undefined) ?? (s.url ? epByUrl.get(s.url) : undefined);
    if (n === undefined) continue;
    const m = citing.get(n) ?? new Map<string, CitingArticle>();
    m.set(s.article.shortId, { shortId: s.article.shortId, title: s.article.title, type: s.article.type });
    citing.set(n, m);
  }

  const progressByKey = new Map(progress.map((p) => [`${p.materialKey}:${p.target}`, p]));
  const progressOf = (n: number, target: ProgressTarget) => progressByKey.get(`${n}:${target}`);

  const rows = all.map((ep): ShowEpisodeRow => {
    const listP = progressOf(ep.episode, "list_row");
    const artP = progressOf(ep.episode, "articles");
    const listArticle = listByEpisode.get(ep.episode) ?? null;
    // 行があれば出ている回。対象外 (出ていない) より行を信じる
    const notAppearing = !listArticle && listP?.status === "excluded";
    const listStatus: TargetStatus = listArticle ? "done" : notAppearing ? "excluded" : "todo";
    const artStatus: TargetStatus = notAppearing
      ? "excluded"
      : artP?.status === "done"
        ? "done"
        : artP?.status === "excluded"
          ? "excluded"
          : "todo";
    const settled = (s: TargetStatus) => s !== "todo";
    const status: EpisodeStatus = notAppearing
      ? "excluded"
      : settled(listStatus) && settled(artStatus)
        ? "done"
        : settled(listStatus) || settled(artStatus)
          ? "partial"
          : "todo";
    return {
      episode: ep.episode,
      date: ep.date,
      title: ep.title,
      videos: ep.videos,
      status,
      listRow: { status: listStatus, article: listArticle, note: listP?.note ?? "" },
      articles: {
        status: artStatus,
        items: [...(citing.get(ep.episode)?.values() ?? [])],
        note: artP?.note ?? "",
      },
    };
  });
  rows.sort((x, y) => y.episode - x.episode);
  return rows;
}

/**
 * 回の反映先の状態を人が決める。`status: null` で取り消す (= 導出に戻る)。
 * - 出演一覧の行: 対象外 (= 出ていない回) だけ。済は記事の行から導出する
 * - 記事化: 済 / 対象外
 */
export async function setShowProgress(
  user: ActingUser,
  showKey: ShowKey,
  episode: number,
  target: "list_row" | "articles",
  status: ProgressStatus | null,
  note = ""
): Promise<void> {
  if (target === "list_row" && status === "done") {
    throw new ProgressInputError("出演一覧の行は記事に行を足すと済になります");
  }
  const ep = (await loadEpisodes(user, showKey, episode)).get(episode);
  if (!ep) throw new ProgressInputError(`#${episode} の動画が Akashic にありません`);
  assertClearance(user.clearance, ep.classification);

  const key = { materialKind: showKey, materialKey: String(episode), target };
  await withClearance(user.clearance, async (tx) => {
    if (status === null) {
      await tx.articleProgress.deleteMany({ where: key });
      return;
    }
    await tx.articleProgress.upsert({
      where: { materialKind_materialKey_target: key },
      create: { ...key, status, note: note.trim(), classification: ep.classification, updatedById: user.id },
      // 後から機密レベルの低い動画が入ることがあるので、書くたびに付け直す
      update: { status, note: note.trim(), classification: ep.classification, updatedById: user.id },
    });
  });
  await logAudit({
    actorId: user.id,
    action: "article_progress.set",
    targetType: "ArticleProgress",
    targetId: `${showKey}:${episode}:${target}`,
    metadata: { status, note: note.trim() },
  });
}

export interface AddListRowResult {
  article: { shortId: string; title: string };
  /** 表に足した行の回番号 (`383` / `20a`) */
  label: string;
  /** push した / しなかった理由 (人の未 push の編集が残っていた・GitHub 未設定・指定なし・衝突・非公開の出典) */
  push: "pushed" | "pending_edits" | "not_configured" | "skipped" | "conflict" | "blocked" | "db_error" | "failed";
}

/**
 * 回の動画 1 本ぶんの行を年度別の出演一覧に足し、動画を出典にする (Discord の 📤 と同じことを画面から)。
 *
 * - 年度の記事は `pickYearArticle`、行の形は表の見出しから (`src/lib/progress/list-row.ts`)
 * - 題は `cells["タイトル"]` (画面で直したもの) → Lemino の企画名 → アセットの題の【】の中
 * - 本文の置き換えと出典の追加は `appendToArticle` で 1 トランザクション (bot の append と同じ経路)
 * - `publish` なら続けてその記事 1 本だけ push する。書く前から push 待ちだった記事 (人の編集が残っている) は
 *   bot と同じく push せず人に任せる
 *
 * `Asset` は保護テーブルなので withClearance。`Article` は非保護なので素の prisma。
 */
export async function addShowListRow(
  user: ActingUser,
  showKey: ShowKey,
  assetId: string,
  cells: Record<string, string>,
  publish: boolean
): Promise<AddListRowResult> {
  const show = SHOWS[showKey];
  const asset = await withClearance(user.clearance, (tx) =>
    tx.asset.findUnique({
      where: { id: assetId },
      select: {
        title: true,
        canonicalDate: true,
        sourceRecords: { select: { url: true, metadata: true }, orderBy: { createdAt: "asc" } },
      },
    })
  );
  if (!asset) throw new ProgressInputError("動画が見つかりません");
  const episode = episodeOf(show, asset.title);
  if (episode === null) throw new ProgressInputError(`${show.label}の回の動画ではありません`);
  const date = toJstDateOnly(asset.canonicalDate);
  if (!date) throw new ProgressInputError("動画に日付がありません");
  const lemino = asset.sourceRecords.find((r) => r.url?.includes("lemino.docomo.ne.jp"));
  // 画面で直した題を優先 (Lemino の出典が無く、題が「26/1/19配信」のような仮のままの回がある)
  const title = cells["タイトル"]?.trim() || leminoKikaku(asset.sourceRecords) || subtitleOf(asset.title.trim());

  const candidates = (
    await prisma.article.findMany({
      where: { title: { endsWith: show.listTitleSuffix } },
      select: { shortId: true, title: true, body: true, updatedAt: true },
    })
  ).filter((a) => isListTitle(show, a.title) && /【\d+年目】/.test(a.title));
  if (candidates.length === 0) throw new ProgressInputError(`年度別の「${show.listTitleSuffix}」の記事がありません`);
  const target = candidates[pickYearArticle(candidates, episode)];

  // 同じ動画の行を二重に足さない (番外編は枝番が進むので、表の回番号だけでは止まらない)
  const already = await withClearance(user.clearance, (tx) =>
    tx.articleSource.findFirst({
      where: { article: { shortId: target.shortId }, OR: [{ assetId }, { originalRef: assetId }] },
      select: { id: true },
    })
  );
  if (already || (lemino?.url && target.body.includes(lemino.url))) {
    throw new ProgressInputError(`「${target.title}」にこの動画の行は既にあります`);
  }
  const suffix = nextSuffix(target.body, episode, show.isExtra(asset.title));
  if (suffix === null) throw new ProgressInputError(`「${target.title}」に #${episode} の行が既にあります`);
  let body: string;
  try {
    body = insertListRow(target.body, { episode, suffix, date, title, url: lemino?.url ?? null, cells });
  } catch (e) {
    throw new ProgressInputError(`「${target.title}」に行を足せません: ${(e as Error).message}`);
  }

  const res = await appendToArticle(
    {
      shortId: target.shortId,
      expectedUpdatedAt: target.updatedAt,
      body,
      articleUpdatedAt: todayJst(),
      sources: [{ assetId, url: lemino?.url ?? null, label: asset.title.trim(), date }],
      actor: { id: user.id },
      // 出典は public で公開リポジトリに載る。アセットを人が選ぶ UI の apply と違い、ここは回から暗黙に決まるので
      // API キー経路と同じ上限にする (confidential 以上の動画を気づかずに公開しない)
      maxClassification: API_APPLY_MAX_CLASSIFICATION,
    },
    user.clearance
  );
  if (!res.ok) {
    const messages: Record<typeof res.reason, string> = {
      not_found: "記事が見つかりません",
      conflict: "記事が同時に更新されました。もう一度押してください",
      invalid: "記事の検証に失敗しました",
      asset_not_found: "動画が見つかりません",
      above_limit: `この動画は ${API_APPLY_MAX_CLASSIFICATION} より上の機密なので、ここからは出典にできません（記事の編集画面から）`,
    };
    throw new ProgressInputError(messages[res.reason]);
  }

  const label = `${episode}${suffix}`;
  let push: AddListRowResult["push"] = "skipped";
  if (publish) {
    if (res.hadPendingEdits) push = "pending_edits";
    else if (!isGithubConfigured()) push = "not_configured";
    else {
      try {
        const r = await pushDirtyArticles(`${show.titleMarker}#${label}『${title}』を出演一覧に追記`, { shortId: target.shortId });
        push = r.commit
          ? r.dbError
            ? "db_error"
            : "pushed"
          : r.conflicts
            ? "conflict"
            : r.blocked
              ? "blocked"
              : "failed";
        if (r.commit) {
          await logAudit({
            actorId: user.id,
            action: "article.push",
            targetType: "github_commit",
            targetId: r.commit.commitSha,
            metadata: { url: r.commit.url, pushed: r.pushed, shortId: target.shortId },
          });
        }
      } catch (e) {
        // 行は DB に入っている (dirty)。push は /articles/push からやり直せる
        console.error("出演一覧の push に失敗:", e);
        push = "failed";
      }
    }
  }
  return { article: { shortId: target.shortId, title: target.title }, label, push };
}
