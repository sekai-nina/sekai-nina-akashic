/**
 * ミーグリ記事の生成 (#109)。
 *
 * ドシエと X レポから記事の本文・出典を組み立てる。組み立て自体は純粋関数
 * (`src/lib/meetgreet/article.ts`) で、ここは DB からの入力の用意に徹する。
 * ドシエの読み方・機密の絞り込み・TikTok の解決は器に依らないので
 * `dossier-materials.ts` にある (#170)。ここに残るのは X レポ収集の keep の合流だけ。
 */

import { withSession } from "@/lib/db";
import { getR2PublicUrl } from "@/lib/r2";
import { todayJst } from "@/lib/utils";
import { MAX_ARTICLE_CLEARANCE } from "@/lib/meetgreet/config";
import {
  normalizeTweetUrl,
  renderMeetGreetArticle,
  type RenderedMeetGreetArticle,
} from "@/lib/meetgreet/article";
import {
  loadDossierForArticle,
  PUBLISHABLE,
  resolveTiktoks,
  shapeDossierMaterials,
} from "./dossier-materials";
import { MeetGreetInputError, type ActingUser } from "./meetgreets";

export { resolveTiktokUrl } from "./dossier-materials";

export interface BuildArticleOptions {
  /** X レポ収集の keep を取り込むか (既存記事との突き合わせ検証では false にする) */
  includeKeeps?: boolean;
  /** published_at / synced_at に入れる日。既定は JST の今日 */
  today?: string;
}

/**
 * ドシエと収集から記事を組み立てる。DB には書かない。
 *
 * レポはドシエの `external_link` を先に、X レポ収集の keep を後ろに足す
 * (既存記事の並びを壊さず、判定済みのぶんだけ増える形にする)。
 */
export async function buildMeetGreetArticle(
  user: ActingUser,
  meetGreet: {
    id: string;
    date: string;
    format: "online" | "real";
    venue: string | null;
    label: string;
    single: string;
    dossierId: string;
    repoCollectionId: string | null;
    sketchKey: string | null;
    classification: string;
  },
  options: BuildArticleOptions = {}
): Promise<RenderedMeetGreetArticle & { droppedByClearance: number }> {
  const includeKeeps = options.includeKeeps ?? true;

  // **記事の本文は公開リポジトリに載る。** アセット単位の絞り込み (PUBLISHABLE) だけでは
  // ドシエのサムネ・外部リンク・スケッチが素通りするので、器の機密も入口で見る
  if (!PUBLISHABLE.has(meetGreet.classification)) {
    throw new MeetGreetInputError(
      `このミーグリは ${meetGreet.classification} なので記事にできません (公開リポジトリに載るため ${MAX_ARTICLE_CLEARANCE} 以下のみ)`
    );
  }

  const data = await withSession(user, async (tx) => {
    const dossier = await loadDossierForArticle(tx, meetGreet.dossierId);
    // ドシエが見えないのは権限の話なので、呼び出し側が 400 にできる形で投げる
    if (!dossier) throw new MeetGreetInputError("ドシエが見つかりません (権限がないか削除されています)");

    const collection = meetGreet.repoCollectionId
      ? await tx.repoCollection.findUnique({
          where: { id: meetGreet.repoCollectionId },
          select: { classification: true },
        })
      : null;

    const keeps =
      includeKeeps && meetGreet.repoCollectionId
        ? await tx.repoTweet.findMany({
            where: { collectionId: meetGreet.repoCollectionId, status: "keep" },
            orderBy: [{ tweetedAt: "asc" }, { id: "asc" }],
            select: { url: true },
          })
        : [];
    if (!PUBLISHABLE.has(dossier.classification)) {
      throw new MeetGreetInputError(
        `ドシエが ${dossier.classification} なので記事にできません (サムネや外部リンクが公開リポジトリに載るため)`
      );
    }
    return { dossier, keeps, collection };
  });

  const materials = shapeDossierMaterials(data.dossier);

  // TikTok は埋め込みに video ID が要るので、短縮 URL をここで解決しておく
  const tiktoks = await resolveTiktoks(materials.tiktoks);

  // keep を後ろに足す (ドシエに既にある URL は重複させない)。
  // RepoTweet は自前の機密を持たず収集の機密に従うので、ここで見る
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
    ...renderMeetGreetArticle({
      date: meetGreet.date,
      format: meetGreet.format,
      // **label は使わない。** label は「通常」「初限」も入る内部用の呼び分けで、
      // タイトルに出すと `リアルミーグリ（通常）` になり、path も既存ファイルとずれて
      // 別記事が新規作成されてしまう。会場名は venue に入れる
      venue: meetGreet.venue?.trim() || null,
      single: meetGreet.single,
      assets: materials.assets,
      reports,
      tiktoks,
      thumbnailUrl: meetGreet.sketchKey ? getR2PublicUrl(meetGreet.sketchKey) : materials.dossierThumb,
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
