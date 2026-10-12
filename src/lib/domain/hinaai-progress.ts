/**
 * ひなあい → 記事の進捗 (#208)。`/progress/hinaai` の裏側。
 *
 * 1 回 (回番号) ごとに反映先が 2 つ:
 * - **出演一覧の行** (`list_row`): 出演一覧の記事に行があれば済 (導出)。対象外 = 出ていない回 (回ごと外す)
 * - **記事化** (`articles`): その回の動画を出典にした記事を並べる。「もう書くことが無い」は記事から
 *   分からないので、済は人が付ける
 *
 * 人が決めた状態は `ArticleProgress` (`materialKind=hinaai`, `materialKey=回番号`)。
 * `Article` は非保護なので素の `prisma`、`Asset` / `ArticleSource` / `ArticleProgress` は `withClearance`。
 */

import type { ClearanceLevel, ProgressStatus, ProgressTarget } from "@prisma/client";
import { prisma, withClearance } from "@/lib/db";
import { accessibleClassifications, assertClearance } from "@/lib/classification";
import { hinaaiEpisodeOf, hinaaiSubtitle, isHinaaiListTitle, isMadamada, listedEpisodes } from "@/lib/progress/hinaai";
import { toJstDateOnly } from "@/lib/utils";
import { WorkflowInputError, type ActingUser } from "./article-workflow";
import { logAudit } from "./audit";

export class ProgressInputError extends WorkflowInputError {}

/** 低い順 (public が先) */
const LEVELS = accessibleClassifications("restricted");

export type TargetStatus = "done" | "excluded" | "todo";
/** 回全体の状態 (一覧の絞り込み用) */
export type EpisodeStatus = "todo" | "partial" | "done" | "excluded";

export interface HinaaiVideo {
  assetId: string;
  title: string;
  madamada: boolean;
}

export interface CitingArticle {
  shortId: string;
  title: string;
  type: string | null;
}

export interface HinaaiEpisodeRow {
  episode: number;
  /** 放送日 (JST)。動画アセットの日付 */
  date: string | null;
  title: string;
  videos: HinaaiVideo[];
  status: EpisodeStatus;
  listRow: { status: TargetStatus; article: { shortId: string; title: string } | null; note: string };
  articles: { status: TargetStatus; items: CitingArticle[]; note: string };
}

interface Episode {
  episode: number;
  date: string | null;
  title: string;
  videos: HinaaiVideo[];
  /** 行の機密レベル。回の動画のうち最も低いもの (= 回が見える人なら誰でも見える) */
  classification: ClearanceLevel;
  assetIds: string[];
  urls: string[];
}

/** `only` を渡すとその回の動画だけを読む (ボタン 1 回ごとに全回を読まない) */
async function loadEpisodes(user: ActingUser, only?: number): Promise<Map<number, Episode>> {
  const assets = await withClearance(user.clearance, (tx) =>
    tx.asset.findMany({
      where: {
        kind: "video",
        // 題の末尾に改行が付いたものがあるので endsWith ではなく contains (回番号は下で照合)
        title: { contains: only === undefined ? "日向坂で会いましょう" : `#${only}` },
      },
      select: {
        id: true,
        title: true,
        canonicalDate: true,
        classification: true,
        sourceRecords: { select: { url: true } },
      },
    })
  );
  const episodes = new Map<number, Episode>();
  for (const a of assets) {
    const n = hinaaiEpisodeOf(a.title);
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
    const madamada = isMadamada(a.title);
    ep.videos.push({ assetId: a.id, title: a.title, madamada });
    ep.assetIds.push(a.id);
    for (const s of a.sourceRecords) if (s.url) ep.urls.push(s.url);
    const date = toJstDateOnly(a.canonicalDate);
    if (date && (!ep.date || date < ep.date)) ep.date = date;
    // 題は本編を優先 (まだまだは副題が「まだまだ…」になる)
    if (!madamada || !ep.title) ep.title = hinaaiSubtitle(a.title);
    if (LEVELS.indexOf(a.classification) < LEVELS.indexOf(ep.classification)) ep.classification = a.classification;
    episodes.set(n, ep);
  }
  for (const ep of episodes.values()) ep.videos.sort((x, y) => Number(x.madamada) - Number(y.madamada));
  return episodes;
}

export async function listHinaaiProgress(user: ActingUser): Promise<HinaaiEpisodeRow[]> {
  const episodes = await loadEpisodes(user);
  const all = [...episodes.values()];
  const epByAsset = new Map(all.flatMap((e) => e.assetIds.map((id) => [id, e.episode] as const)));
  const epByUrl = new Map(all.flatMap((e) => e.urls.map((u) => [u, e.episode] as const)));

  const [lists, sources, progress] = await Promise.all([
    prisma.article.findMany({
      where: { title: { endsWith: "日向坂で会いましょう出演一覧" } },
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
        where: { materialKind: "hinaai" },
        select: { materialKey: true, target: true, status: true, note: true },
      })
    ),
  ]);

  const listByEpisode = new Map<number, { shortId: string; title: string }>();
  for (const l of lists) {
    if (!isHinaaiListTitle(l.title)) continue;
    for (const n of listedEpisodes(l.body)) if (!listByEpisode.has(n)) listByEpisode.set(n, { shortId: l.shortId, title: l.title });
  }

  const citing = new Map<number, Map<string, CitingArticle>>();
  for (const s of sources) {
    if (isHinaaiListTitle(s.article.title)) continue;
    const n = (s.assetId ? epByAsset.get(s.assetId) : undefined) ?? (s.url ? epByUrl.get(s.url) : undefined);
    if (n === undefined) continue;
    const m = citing.get(n) ?? new Map<string, CitingArticle>();
    m.set(s.article.shortId, { shortId: s.article.shortId, title: s.article.title, type: s.article.type });
    citing.set(n, m);
  }

  const progressByKey = new Map(progress.map((p) => [`${p.materialKey}:${p.target}`, p]));
  const progressOf = (n: number, target: ProgressTarget) => progressByKey.get(`${n}:${target}`);

  const rows = all.map((ep): HinaaiEpisodeRow => {
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
export async function setHinaaiProgress(
  user: ActingUser,
  episode: number,
  target: "list_row" | "articles",
  status: ProgressStatus | null,
  note = ""
): Promise<void> {
  if (target === "list_row" && status === "done") {
    throw new ProgressInputError("出演一覧の行は記事に行を足すと済になります");
  }
  const ep = (await loadEpisodes(user, episode)).get(episode);
  if (!ep) throw new ProgressInputError(`#${episode} の動画が Akashic にありません`);
  assertClearance(user.clearance, ep.classification);

  const key = { materialKind: "hinaai" as const, materialKey: String(episode), target };
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
    targetId: `hinaai:${episode}:${target}`,
    metadata: { status, note: note.trim() },
  });
}
