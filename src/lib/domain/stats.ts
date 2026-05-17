import { prismaInternal as prisma } from "@/lib/db";

export interface DashboardStats {
  blog: {
    postCount: number;
    imageCount: number;
    totalChars: number;
    discoveryCount: number;
  };
  talk: {
    messageCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
    totalChars: number;
  };
  media: {
    hinaai: number;
    hinanari: number;
    hinach: number;
    official: number;
    magazine: number;
  };
  live: {
    count: number;
    totalSongs: number;
    centerSongs: number;
  };
  total: {
    assetCount: number;
  };
}

const NINA_ENTITY_ID = "cmmtp8vrg0004mo381neyztvn";

interface CountsRow {
  blog_posts: bigint;
  blog_images: bigint;
  talk_messages: bigint;
  talk_images: bigint;
  talk_videos: bigint;
  talk_audios: bigint;
  total_assets: bigint;
  discovery: bigint;
  hinaai: bigint;
  hinanari: bigint;
  hinach: bigint;
  official: bigint;
  magazine: bigint;
  live: bigint;
}

interface CharsRow {
  blog_chars: bigint;
  talk_chars: bigint;
  live_songs: bigint;
  live_center: bigint;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  // Two consolidated queries instead of 18 individual ones
  const [countsResult, charsResult] = await Promise.all([
    prisma.$queryRaw<[CountsRow]>`
      SELECT
        (SELECT COUNT(*) FROM "Asset" a
          JOIN "AssetEntity" ae ON ae."assetId" = a.id
          WHERE a."sourceType" = 'web' AND a.kind = 'text' AND ae."entityId" = ${NINA_ENTITY_ID}
        ) AS blog_posts,
        (SELECT COUNT(*) FROM "Asset" a
          JOIN "AssetEntity" ae ON ae."assetId" = a.id
          WHERE a."sourceType" = 'web' AND a.kind = 'image' AND ae."entityId" = ${NINA_ENTITY_ID}
        ) AS blog_images,
        (SELECT COUNT(*) FROM "Asset" WHERE "sourceType" = 'import' AND kind = 'text') AS talk_messages,
        (SELECT COUNT(*) FROM "Asset" WHERE "sourceType" = 'import' AND kind = 'image') AS talk_images,
        (SELECT COUNT(*) FROM "Asset" WHERE "sourceType" = 'import' AND kind = 'video') AS talk_videos,
        (SELECT COUNT(*) FROM "Asset" WHERE "sourceType" = 'import' AND kind = 'audio') AS talk_audios,
        (SELECT COUNT(*) FROM "Asset") AS total_assets,
        (SELECT COUNT(*) FROM "AssetEntity" ae JOIN "Entity" e ON e.id = ae."entityId" WHERE e.type = 'tag' AND e."normalizedName" = '今日の発見') AS discovery,
        (SELECT COUNT(*) FROM "AssetEntity" ae JOIN "Entity" e ON e.id = ae."entityId" WHERE e.type = 'tag' AND e."normalizedName" = '日向坂で会いましょう') AS hinaai,
        (SELECT COUNT(*) FROM "AssetEntity" ae JOIN "Entity" e ON e.id = ae."entityId" WHERE e.type = 'tag' AND e."normalizedName" = '日向坂になりましょう') AS hinanari,
        (SELECT COUNT(*) FROM "AssetEntity" ae JOIN "Entity" e ON e.id = ae."entityId" WHERE e.type = 'tag' AND e."normalizedName" = '日向坂ちゃんねる') AS hinach,
        (SELECT COUNT(*) FROM "AssetEntity" ae JOIN "Entity" e ON e.id = ae."entityId" WHERE e.type = 'tag' AND e."normalizedName" = '日向坂46公式チャンネル') AS official,
        (SELECT COUNT(*) FROM "AssetEntity" ae JOIN "Entity" e ON e.id = ae."entityId" WHERE e.type = 'tag' AND e."normalizedName" = '雑誌') AS magazine,
        (SELECT COUNT(*) FROM "AssetEntity" ae JOIN "Entity" e ON e.id = ae."entityId" WHERE e.type = 'tag' AND e."canonicalName" = 'ライブ') AS live
    `,
    prisma.$queryRaw<[CharsRow]>`
      SELECT
        (SELECT COALESCE(SUM(LENGTH(t.content)), 0)
          FROM "AssetText" t
          JOIN "Asset" a ON a.id = t."assetId"
          JOIN "AssetEntity" ae ON ae."assetId" = a.id
          WHERE a."sourceType" = 'web' AND a.kind = 'text'
            AND t."textType" IN ('body', 'message_body')
            AND ae."entityId" = ${NINA_ENTITY_ID}
        ) AS blog_chars,
        (SELECT COALESCE(SUM(LENGTH(t.content)), 0)
          FROM "AssetText" t
          JOIN "Asset" a ON a.id = t."assetId"
          WHERE a."sourceType" = 'import' AND a.kind = 'text'
            AND t."textType" IN ('body', 'message_body')
        ) AS talk_chars,
        (SELECT COALESCE(SUM(array_length(string_to_array(t.content, ';'), 1)), 0)
          FROM "AssetText" t
          JOIN "AssetEntity" ae ON ae."assetId" = t."assetId"
          JOIN "Entity" e ON e.id = ae."entityId"
          WHERE e."canonicalName" = 'ライブ' AND e.type = 'tag'
            AND t."textType" = 'body' AND t.content != ''
        ) AS live_songs,
        (SELECT COALESCE(SUM(array_length(string_to_array(t.content, ';'), 1)), 0)
          FROM "AssetText" t
          JOIN "AssetEntity" ae ON ae."assetId" = t."assetId"
          JOIN "Entity" e ON e.id = ae."entityId"
          WHERE e."canonicalName" = 'ライブ' AND e.type = 'tag'
            AND t."textType" = 'note' AND t.content != ''
        ) AS live_center
    `,
  ]);

  const counts = countsResult[0];
  const chars = charsResult[0];

  return {
    blog: {
      postCount: Number(counts.blog_posts),
      imageCount: Number(counts.blog_images),
      totalChars: Number(chars.blog_chars),
      discoveryCount: Number(counts.discovery),
    },
    talk: {
      messageCount: Number(counts.talk_messages),
      imageCount: Number(counts.talk_images),
      videoCount: Number(counts.talk_videos),
      audioCount: Number(counts.talk_audios),
      totalChars: Number(chars.talk_chars),
    },
    media: {
      hinaai: Number(counts.hinaai),
      hinanari: Number(counts.hinanari),
      hinach: Number(counts.hinach),
      official: Number(counts.official),
      magazine: Number(counts.magazine),
    },
    live: {
      count: Number(counts.live),
      totalSongs: Number(chars.live_songs),
      centerSongs: Number(chars.live_center),
    },
    total: {
      assetCount: Number(counts.total_assets),
    },
  };
}
