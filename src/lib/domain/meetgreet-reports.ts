/**
 * 記事に載る予定の X レポを読む (#135)。
 *
 * 画面には「採用 8 / 取得 99」としか出ておらず、**どのツイートが記事に載るのかが
 * 見えなかった**。判定は `/repo` で行うが、押す前に中身を確かめられるよう、
 * ここで採用ぶんの本文と写真を返す。
 */

import { accessibleClassifications } from "@/lib/classification";
import { withClearance } from "@/lib/db";
import { getR2PublicUrl } from "@/lib/r2";
import { MAX_ARTICLE_CLEARANCE, MAX_KEEP_TWEETS_SHOWN } from "@/lib/meetgreet/config";
import type { ActingUser } from "./meetgreets";

/** 記事の本文に載せてよい機密レベル (`meetgreet-article.ts` と同じ) */
const PUBLISHABLE = new Set<string>(accessibleClassifications(MAX_ARTICLE_CLEARANCE));

export interface KeepTweet {
  id: string;
  url: string;
  authorName: string;
  authorUsername: string;
  text: string;
  tweetedAt: string | null;
  media: { id: string; url: string; altText: string }[];
}

export interface MeetGreetKeeps {
  tweets: KeepTweet[];
  /** 採用の総数 (`tweets` は先頭 `MAX_KEEP_TWEETS_SHOWN` 件までに切る) */
  total: number;
  /**
   * 記事に載るか。収集の機密レベルが記事の上限を超えていると、採用していても
   * 本文に出ない (`buildMeetGreetArticle` が落とす)。画面でも同じことを言う
   */
  publishable: boolean;
}

export async function listMeetGreetKeeps(
  user: ActingUser,
  meetGreet: { repoCollectionId: string | null }
): Promise<MeetGreetKeeps | null> {
  const collectionId = meetGreet.repoCollectionId;
  if (!collectionId) return null;

  return withClearance(user.clearance, async (tx) => {
    // **収集ごと見えないことがある** (機密レベルが上がった / RLS)。その場合は null
    const collection = await tx.repoCollection.findUnique({
      where: { id: collectionId },
      select: { classification: true },
    });
    if (!collection) return null;

    const [rows, total] = await Promise.all([
      tx.repoTweet.findMany({
        where: { collectionId, status: "keep" },
        orderBy: { tweetedAt: "asc" },
        take: MAX_KEEP_TWEETS_SHOWN,
        select: {
          id: true,
          url: true,
          authorName: true,
          authorUsername: true,
          text: true,
          tweetedAt: true,
          media: { select: { id: true, imageKey: true, remoteUrl: true, altText: true } },
        },
      }),
      tx.repoTweet.count({ where: { collectionId, status: "keep" } }),
    ]);

    return {
      total,
      publishable: PUBLISHABLE.has(collection.classification),
      tweets: rows.map((t) => ({
        id: t.id,
        url: t.url,
        authorName: t.authorName,
        authorUsername: t.authorUsername,
        text: t.text,
        tweetedAt: t.tweetedAt?.toISOString() ?? null,
        media: t.media.flatMap((m) => {
          // R2 に載っていないものは元 URL で出す (X 側が消えていれば表示されないだけ)
          const url = m.imageKey ? getR2PublicUrl(m.imageKey) : m.remoteUrl;
          return url ? [{ id: m.id, url, altText: m.altText }] : [];
        }),
      })),
    };
  });
}
