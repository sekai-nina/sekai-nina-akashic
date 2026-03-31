import { prisma } from "@/lib/db";

export interface DashboardStats {
  blog: {
    postCount: number;
    imageCount: number;
    totalChars: number;
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
  ] = await Promise.all([
    prisma.asset.count({ where: { sourceType: "web", kind: "text" } }),
    prisma.asset.count({ where: { sourceType: "web", kind: "image" } }),
    prisma.asset.count({ where: { sourceType: "import", kind: "text" } }),
    prisma.asset.count({ where: { sourceType: "import", kind: "image" } }),
    prisma.asset.count({ where: { sourceType: "import", kind: "video" } }),
    prisma.asset.count({ where: { sourceType: "import", kind: "audio" } }),
    prisma.asset.count(),
    // ブログ（web）テキストの文字数合計
    prisma.$queryRaw<[{ total: bigint }]>`
      SELECT COALESCE(SUM(LENGTH(t.content)), 0) AS total
      FROM "AssetText" t
      JOIN "Asset" a ON a.id = t."assetId"
      WHERE a."sourceType" = 'web'
        AND a.kind = 'text'
        AND t."textType" IN ('body', 'message_body')
    `,
    // トーク（import）テキストの文字数合計
    prisma.$queryRaw<[{ total: bigint }]>`
      SELECT COALESCE(SUM(LENGTH(t.content)), 0) AS total
      FROM "AssetText" t
      JOIN "Asset" a ON a.id = t."assetId"
      WHERE a."sourceType" = 'import'
        AND a.kind = 'text'
        AND t."textType" IN ('body', 'message_body')
    `,
  ]);

  return {
    blog: {
      postCount: blogPostCount,
      imageCount: blogImageCount,
      totalChars: Number(blogCharsResult[0].total),
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
