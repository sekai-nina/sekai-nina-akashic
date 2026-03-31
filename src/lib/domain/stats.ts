import { prisma } from "@/lib/db";

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
  total: {
    assetCount: number;
  };
}

// 坂井新奈のperson entity ID
const NINA_ENTITY_ID = "cmmtp8vrg0004mo381neyztvn";

// 坂井新奈に紐づくアセットのフィルタ条件
const ninaFilter = {
  entities: { some: { entityId: NINA_ENTITY_ID } },
};

export async function getDashboardStats(): Promise<DashboardStats> {
  const [
    blogPostCount,
    blogImageCount,
    talkMessageCount,
    talkImageCount,
    talkVideoCount,
    talkAudioCount,
    totalAssetCount,
    blogCharsResult,
    talkCharsResult,
    discoveryCount,
  ] = await Promise.all([
    prisma.asset.count({ where: { sourceType: "web", kind: "text", ...ninaFilter } }),
    prisma.asset.count({ where: { sourceType: "web", kind: "image", ...ninaFilter } }),
    prisma.asset.count({ where: { sourceType: "import", kind: "text" } }),
    prisma.asset.count({ where: { sourceType: "import", kind: "image" } }),
    prisma.asset.count({ where: { sourceType: "import", kind: "video" } }),
    prisma.asset.count({ where: { sourceType: "import", kind: "audio" } }),
    prisma.asset.count(),
    // 坂井新奈のブログ文字数合計
    prisma.$queryRaw<[{ total: bigint }]>`
      SELECT COALESCE(SUM(LENGTH(t.content)), 0) AS total
      FROM "AssetText" t
      JOIN "Asset" a ON a.id = t."assetId"
      JOIN "AssetEntity" ae ON ae."assetId" = a.id
      WHERE a."sourceType" = 'web'
        AND a.kind = 'text'
        AND t."textType" IN ('body', 'message_body')
        AND ae."entityId" = ${NINA_ENTITY_ID}
    `,
    // トーク文字数合計（トークは坂井新奈のみ）
    prisma.$queryRaw<[{ total: bigint }]>`
      SELECT COALESCE(SUM(LENGTH(t.content)), 0) AS total
      FROM "AssetText" t
      JOIN "Asset" a ON a.id = t."assetId"
      WHERE a."sourceType" = 'import'
        AND a.kind = 'text'
        AND t."textType" IN ('body', 'message_body')
    `,
    // 「今日の発見」タグがついたアセット数
    prisma.assetEntity.count({
      where: {
        entity: {
          type: "tag",
          normalizedName: "今日の発見",
        },
      },
    }),
  ]);

  return {
    blog: {
      postCount: blogPostCount,
      imageCount: blogImageCount,
      totalChars: Number(blogCharsResult[0].total),
      discoveryCount,
    },
    talk: {
      messageCount: talkMessageCount,
      imageCount: talkImageCount,
      videoCount: talkVideoCount,
      audioCount: talkAudioCount,
      totalChars: Number(talkCharsResult[0].total),
    },
    total: {
      assetCount: totalAssetCount,
    },
  };
}
