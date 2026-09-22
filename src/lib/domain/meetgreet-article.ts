/**
 * ミーグリ記事の生成 (#109)。
 *
 * ドシエと X レポから記事の本文・出典を組み立てる。組み立て自体は純粋関数
 * (`src/lib/meetgreet/article.ts`) で、ここは DB からの入力の用意に徹する。
 * ドシエの読み方・機密の絞り込み・X レポ収集の keep の合流・TikTok の解決は器に依らないので
 * `dossier-materials.ts` (`loadContainerMaterials`) にある (#170 / #151)。
 */

import { getR2PublicUrl } from "@/lib/r2";
import { todayJst } from "@/lib/utils";
import { MAX_ARTICLE_CLEARANCE } from "@/lib/meetgreet/config";
import { renderMeetGreetArticle, type RenderedMeetGreetArticle } from "@/lib/meetgreet/article";
import { loadContainerMaterials, PUBLISHABLE } from "./dossier-materials";
import { MeetGreetInputError, type ActingUser } from "./meetgreets";

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

  const loaded = await loadContainerMaterials(
    user,
    { dossierId: meetGreet.dossierId, repoCollectionId: meetGreet.repoCollectionId, includeKeeps },
    (message) => new MeetGreetInputError(message)
  );

  return {
    ...renderMeetGreetArticle({
      date: meetGreet.date,
      format: meetGreet.format,
      // **label は使わない。** label は「通常」「初限」も入る内部用の呼び分けで、
      // タイトルに出すと `リアルミーグリ（通常）` になり、path も既存ファイルとずれて
      // 別記事が新規作成されてしまう。会場名は venue に入れる
      venue: meetGreet.venue?.trim() || null,
      single: meetGreet.single,
      assets: loaded.materials.assets,
      reports: loaded.reports,
      tiktoks: loaded.tiktoks,
      thumbnailUrl: meetGreet.sketchKey ? getR2PublicUrl(meetGreet.sketchKey) : loaded.materials.dossierThumb,
      dossier: loaded.dossier,
      today: options.today ?? todayJst(),
    }),
    droppedByClearance: loaded.materials.droppedByClearance,
  };
}
