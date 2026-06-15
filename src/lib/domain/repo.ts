/**
 * レポ収集 (curepo 由来) のドメイン層。
 *
 * Twitter のミーグリレポを公式 X API で収集し、ツイート/メタ情報を Supabase(Prisma) に、
 * 画像を 640px WebP に軽量化して R2 に保存する。選別(keep/reject)は人間が行う。
 *
 * RepoCollection/RepoTweet/RepoTweetMedia は RLS 有効。owner ベースは無いので
 * withClearance(clearance, ...) で十分（app.clearance のみ設定）。
 */

import sharp from "sharp";
import { Prisma, RepoTweetStatus } from "@prisma/client";
import { withClearance } from "@/lib/db";
import { uploadToR2, deleteFromR2, getR2PublicUrl, isR2Configured } from "@/lib/r2";
import {
  buildQuery,
  clampRecentWindow,
  jstDateToUtcRfc3339,
  highResImageUrl,
  xSearchRecent,
  DEFAULT_MAX_PAGES,
  type HashtagGroup,
} from "@/lib/twitter/x-search";

const GALLERY_WIDTH = 640;

export interface CreateCollectionInput {
  name: string;
  groups: HashtagGroup[];
  groupOp: "and" | "or";
  startDate: string | null;
  endDate: string | null;
  excludeRetweets: boolean;
  langJa: boolean;
  extra: string;
}

export type TweetSort = "newest" | "oldest" | "likes";

// --- collections ---

/** 収集一覧（各収集の total/keep/reject/undecided 件数集計付き）。 */
export async function listCollections(clearance: string) {
  return withClearance(clearance, async (tx) => {
    const collections = await tx.repoCollection.findMany({
      orderBy: { createdAt: "desc" },
    });

    const grouped = await tx.repoTweet.groupBy({
      by: ["collectionId", "status"],
      _count: { _all: true },
    });

    const counts = new Map<
      string,
      { total: number; keep: number; reject: number; undecided: number }
    >();
    for (const g of grouped) {
      const c =
        counts.get(g.collectionId) ?? { total: 0, keep: 0, reject: 0, undecided: 0 };
      const n = g._count._all;
      c.total += n;
      c[g.status] += n;
      counts.set(g.collectionId, c);
    }

    return collections.map((c) => ({
      ...c,
      ...(counts.get(c.id) ?? { total: 0, keep: 0, reject: 0, undecided: 0 }),
    }));
  });
}

export async function getCollection(id: string, clearance: string) {
  return withClearance(clearance, (tx) => tx.repoCollection.findUnique({ where: { id } }));
}

export async function createCollection(input: CreateCollectionInput, clearance: string) {
  const query = buildQuery(
    input.groups,
    input.groupOp,
    input.excludeRetweets,
    input.langJa,
    input.extra
  );
  return withClearance(clearance, (tx) =>
    tx.repoCollection.create({
      data: {
        name: input.name,
        groups: input.groups as unknown as Prisma.InputJsonValue,
        groupOp: input.groupOp,
        query,
        startDate: input.startDate,
        endDate: input.endDate,
        excludeRetweets: input.excludeRetweets,
        langJa: input.langJa,
        extra: input.extra,
      },
    })
  );
}

export async function renameCollection(id: string, name: string, clearance: string) {
  return withClearance(clearance, (tx) =>
    tx.repoCollection.update({ where: { id }, data: { name } })
  );
}

/** 収集を削除（ツイート/メディアは cascade）。R2 上の画像も best-effort で削除。 */
export async function deleteCollection(id: string, clearance: string) {
  const imageKeys = await withClearance(clearance, async (tx) => {
    const media = await tx.repoTweetMedia.findMany({
      where: { tweet: { collectionId: id }, imageKey: { not: null } },
      select: { imageKey: true },
    });
    await tx.repoCollection.delete({ where: { id } });
    return media.map((m) => m.imageKey!).filter(Boolean);
  });

  if (isR2Configured()) {
    await Promise.allSettled(imageKeys.map((k) => deleteFromR2(k)));
  }
}

// --- tweets / curation ---

export async function listTweets(
  collectionId: string,
  opts: { status?: RepoTweetStatus; sort?: TweetSort },
  clearance: string
) {
  const orderBy: Prisma.RepoTweetOrderByWithRelationInput =
    opts.sort === "oldest"
      ? { tweetedAt: "asc" }
      : opts.sort === "likes"
        ? { likeCount: "desc" }
        : { tweetedAt: "desc" };

  return withClearance(clearance, async (tx) => {
    const tweets = await tx.repoTweet.findMany({
      where: { collectionId, ...(opts.status && { status: opts.status }) },
      include: { media: true },
      orderBy,
    });
    return tweets.map((t) => ({
      ...t,
      media: t.media.map((m) => ({
        ...m,
        imageUrl: m.imageKey ? getR2PublicUrl(m.imageKey) : m.remoteUrl,
      })),
    }));
  });
}

export async function setTweetStatus(
  tweetId: string,
  status: RepoTweetStatus,
  clearance: string
) {
  return withClearance(clearance, (tx) =>
    tx.repoTweet.update({ where: { id: tweetId }, data: { status } })
  );
}

export async function bulkSetStatus(
  collectionId: string,
  from: RepoTweetStatus,
  to: RepoTweetStatus,
  clearance: string
) {
  return withClearance(clearance, (tx) =>
    tx.repoTweet.updateMany({
      where: { collectionId, status: from },
      data: { status: to },
    })
  );
}

// --- export ---

export async function exportCollection(
  collectionId: string,
  fmt: "links" | "markdown" | "csv",
  status: RepoTweetStatus | "all",
  clearance: string
): Promise<string> {
  const rows = await withClearance(clearance, (tx) =>
    tx.repoTweet.findMany({
      where: { collectionId, ...(status !== "all" && { status }) },
      orderBy: { tweetedAt: "asc" },
    })
  );

  if (fmt === "markdown") {
    return rows
      .map((t) => {
        const first = (t.text || "").split("\n")[0].slice(0, 80);
        return `- [@${t.authorUsername}: ${first}](${t.url})`;
      })
      .join("\n");
  }
  if (fmt === "csv") {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const header = "url,author_username,author_name,created_at,like_count,retweet_count,text";
    const lines = rows.map((t) =>
      [
        t.url,
        t.authorUsername,
        t.authorName,
        t.tweetedAt?.toISOString() ?? "",
        String(t.likeCount),
        String(t.retweetCount),
        (t.text || "").replace(/\n/g, " "),
      ]
        .map(esc)
        .join(",")
    );
    return [header, ...lines].join("\n");
  }
  // default: plain links
  return rows.map((t) => t.url).join("\n");
}

// --- fetch (収集本体) ---

/** 1枚を 640px WebP に軽量化して R2 に保存し、key を返す。失敗時 null。 */
async function lightenAndUpload(
  collectionId: string,
  tweetId: string,
  mediaKey: string,
  sourceUrl: string
): Promise<string | null> {
  try {
    const res = await fetch(sourceUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const webp = await sharp(buf)
      .rotate()
      .resize(GALLERY_WIDTH, null, { withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    const key = `repo/${collectionId}/${tweetId}/${mediaKey}.webp`;
    await uploadToR2(key, webp, "image/webp");
    return key;
  } catch {
    return null; // 画像欠落は致命的でない
  }
}

export interface FetchResult {
  fetched: number;
  added: number;
  mediaSaved: number;
}

/**
 * 収集を実行: X API でツイート取得 → 画像を軽量化して R2 → DB へ upsert。
 * 既存ツイートは status/note を保持しつつメトリクスのみ更新。
 *
 * ネットワーク重処理（画像 DL/変換/アップロード）はトランザクション外で行い、
 * DB 書き込みのみ短いトランザクションに収める。maxPages で有界（暴走防止）。
 */
export async function fetchCollection(
  collectionId: string,
  clearance: string,
  maxPages = DEFAULT_MAX_PAGES
): Promise<FetchResult> {
  const collection = await getCollection(collectionId, clearance);
  if (!collection) throw new Error("collection not found");

  const startRfc = collection.startDate
    ? jstDateToUtcRfc3339(collection.startDate, false)
    : null;
  const endRfc = collection.endDate
    ? jstDateToUtcRfc3339(collection.endDate, true)
    : null;
  const { start, end } = clampRecentWindow(startRfc, endRfc);

  const tweets = await xSearchRecent(collection.query, start, end, maxPages);

  // 既存メディア（imageKey 済み）を把握して再アップロードを避ける
  const existingMedia = await withClearance(clearance, (tx) =>
    tx.repoTweetMedia.findMany({
      where: { tweet: { collectionId }, imageKey: { not: null } },
      select: { mediaKey: true, tweet: { select: { tweetId: true } } },
    })
  );
  const haveImage = new Set(
    existingMedia.map((m) => `${m.tweet.tweetId}:${m.mediaKey}`)
  );

  // --- トランザクション外: 画像を軽量化して R2 へ ---
  const uploaded = new Map<string, string>(); // `${tweetId}:${mediaKey}` -> r2 key
  let mediaSaved = 0;
  if (isR2Configured()) {
    for (const t of tweets) {
      for (const item of t.media) {
        const tag = `${t.tweetId}:${item.mediaKey}`;
        if (haveImage.has(tag)) continue;
        const key = await lightenAndUpload(
          collectionId,
          t.tweetId,
          item.mediaKey,
          highResImageUrl(item)
        );
        if (key) {
          uploaded.set(tag, key);
          mediaSaved++;
        }
      }
    }
  }

  // --- トランザクション内: DB へ upsert ---
  let added = 0;
  await withClearance(clearance, async (tx) => {
    for (const t of tweets) {
      const existing = await tx.repoTweet.findUnique({
        where: { collectionId_tweetId: { collectionId, tweetId: t.tweetId } },
        select: { id: true },
      });

      let rowId: string;
      if (existing) {
        await tx.repoTweet.update({
          where: { id: existing.id },
          data: {
            likeCount: t.likeCount,
            retweetCount: t.retweetCount,
            replyCount: t.replyCount,
            quoteCount: t.quoteCount,
          },
        });
        rowId = existing.id;
      } else {
        const created = await tx.repoTweet.create({
          data: {
            collectionId,
            tweetId: t.tweetId,
            authorUsername: t.authorUsername,
            authorName: t.authorName,
            text: t.text,
            tweetedAt: t.createdAt ? new Date(t.createdAt) : null,
            likeCount: t.likeCount,
            retweetCount: t.retweetCount,
            replyCount: t.replyCount,
            quoteCount: t.quoteCount,
            url: t.url,
          },
        });
        rowId = created.id;
        added++;
      }

      for (const item of t.media) {
        const tag = `${t.tweetId}:${item.mediaKey}`;
        const imageKey = uploaded.get(tag) ?? null;
        await tx.repoTweetMedia.upsert({
          where: { tweetId_mediaKey: { tweetId: rowId, mediaKey: item.mediaKey } },
          create: {
            tweetId: rowId,
            mediaKey: item.mediaKey,
            type: item.type,
            remoteUrl: item.imageUrl,
            imageKey,
            width: item.width,
            height: item.height,
            altText: item.altText,
          },
          update: {
            // 既存に imageKey が無く今回取得できた場合のみ補完
            ...(imageKey ? { imageKey } : {}),
            remoteUrl: item.imageUrl,
          },
        });
      }
    }

    await tx.repoCollection.update({
      where: { id: collectionId },
      data: { lastFetchedAt: new Date() },
    });
  });

  return { fetched: tweets.length, added, mediaSaved };
}
