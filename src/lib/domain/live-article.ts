/**
 * ライブ記事の生成 (#151)。
 *
 * ミーグリ (`meetgreet-article.ts`) と同型: ドシエと X レポ収集から入力を用意し、組み立ては純粋関数
 * (`src/lib/article-workflow/templates/live.ts`)。違いは公演・曲 (器が持つ構造化メタ) を渡すこと。
 */

import { withSession } from "@/lib/db";
import { getR2PublicUrl } from "@/lib/r2";
import { todayJst } from "@/lib/utils";
import { MAX_ARTICLE_CLEARANCE } from "@/lib/meetgreet/config";
import { normalizeTweetUrl } from "@/lib/article-workflow/render";
import { renderLiveArticle, type RenderedLiveArticle } from "@/lib/article-workflow/templates/live";
import {
  loadDossierForArticle,
  PUBLISHABLE,
  resolveTiktoks,
  shapeDossierMaterials,
} from "./dossier-materials";
import { LiveInputError, type ActingUser, type LivePerformanceView } from "./lives";

/** 記事の器としてのライブ (`getLive` の返り値で足りる) */
export interface LiveForArticle {
  id: string;
  name: string;
  note: string;
  dossierId: string;
  repoCollectionId: string | null;
  sketchKey: string | null;
  articleId: string | null;
  classification: string;
  /** 「足さない」と決めたもののキー (#134) */
  articleExclusions: unknown;
  performances: LivePerformanceView[];
  commonSongs: string[];
}

export interface BuildLiveArticleOptions {
  /** X レポ収集の keep を取り込むか */
  includeKeeps?: boolean;
  /** published_at / synced_at に入れる日。既定は JST の今日 */
  today?: string;
}

/**
 * ドシエ・収集・公演から記事を組み立てる。DB には書かない。
 * レポはドシエの `external_link` を先に、X レポ収集の keep を後ろに足す (ミーグリと同じ)
 */
export async function buildLiveArticle(
  user: ActingUser,
  live: LiveForArticle,
  options: BuildLiveArticleOptions = {}
): Promise<RenderedLiveArticle & { droppedByClearance: number }> {
  const includeKeeps = options.includeKeeps ?? true;

  // **記事の本文は公開リポジトリに載る。** 器の機密も入口で見る (ライブ名・会場名・スケッチが載る)
  if (!PUBLISHABLE.has(live.classification)) {
    throw new LiveInputError(
      `このライブは ${live.classification} なので記事にできません (公開リポジトリに載るため ${MAX_ARTICLE_CLEARANCE} 以下のみ)`
    );
  }

  const data = await withSession(user, async (tx) => {
    const dossier = await loadDossierForArticle(tx, live.dossierId);
    if (!dossier) throw new LiveInputError("ドシエが見つかりません (権限がないか削除されています)");
    if (!PUBLISHABLE.has(dossier.classification)) {
      throw new LiveInputError(
        `ドシエが ${dossier.classification} なので記事にできません (サムネや外部リンクが公開リポジトリに載るため)`
      );
    }
    const collection = live.repoCollectionId
      ? await tx.repoCollection.findUnique({
          where: { id: live.repoCollectionId },
          select: { classification: true },
        })
      : null;
    const keeps =
      includeKeeps && live.repoCollectionId
        ? await tx.repoTweet.findMany({
            where: { collectionId: live.repoCollectionId, status: "keep" },
            orderBy: [{ tweetedAt: "asc" }, { id: "asc" }],
            select: { url: true },
          })
        : [];
    return { dossier, keeps, collection };
  });

  const materials = shapeDossierMaterials(data.dossier);
  const tiktoks = await resolveTiktoks(materials.tiktoks);

  // keep を後ろに足す (ドシエに既にある URL は重複させない)。RepoTweet は収集の機密に従う
  const reports = [...materials.reports];
  const keepsPublishable = !data.collection || PUBLISHABLE.has(data.collection.classification);
  const seen = new Set(reports.map(normalizeTweetUrl));
  for (const t of keepsPublishable ? data.keeps : []) {
    const n = normalizeTweetUrl(t.url);
    if (seen.has(n)) continue;
    seen.add(n);
    reports.push(t.url);
  }

  return {
    ...renderLiveArticle({
      name: live.name,
      note: live.note,
      performances: live.performances.map((p) => ({
        date: p.date,
        venue: p.venue,
        label: p.label,
        note: p.note,
        songs: p.songs,
        centerSongs: p.centerSongs,
      })),
      commonSongs: live.commonSongs,
      assets: materials.assets,
      reports,
      tiktoks,
      thumbnailUrl: live.sketchKey ? getR2PublicUrl(live.sketchKey) : materials.dossierThumb,
      dossier: {
        id: data.dossier.id,
        updatedAt: data.dossier.updatedAt.toISOString(),
        itemCount: data.dossier.itemCount,
      },
      today: options.today ?? todayJst(),
    }),
    droppedByClearance: materials.droppedByClearance,
  };
}
