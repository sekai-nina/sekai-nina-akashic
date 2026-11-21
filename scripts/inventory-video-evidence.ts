/** 大規模評価の母集団を固定する。スコア・タグを正解ラベルには変換しない。 */
import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  if (!process.env.DIRECT_URL) throw new Error("DIRECT_URL が必要です");
  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
  try {
    const items = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '20000ms'");
      return tx.$queryRaw<{
        videoId: string; assetId: string; durationSec: number | null; fileSize: number;
        sha256: string | null; createTime: Date; handle: string; legacyMaxSimilarity: number | null;
      }[]>(Prisma.sql`
        SELECT t."videoId", a.id AS "assetId", t."durationSec", a."fileSize", a.sha256, t."createTime", w.handle,
          MAX(f.similarity) FILTER (WHERE f."predictedEntityId" = 'cmmtp8vrg0004mo381neyztvn') AS "legacyMaxSimilarity"
        FROM "TiktokVideo" t JOIN "Asset" a ON a.id = t."assetId"
        JOIN "TiktokWatchTarget" w ON w.id = t."targetId"
        LEFT JOIN "FaceDetection" f ON f."assetId" = a.id
        WHERE a.classification IN ('public', 'internal') AND t.classification IN ('public', 'internal')
          AND w.classification IN ('public', 'internal')
          AND a.kind = 'video' AND a."storageProvider" = 'gdrive' AND a."storageKey" IS NOT NULL
          AND a."fileSize" BETWEEN 1 AND 200000000
        GROUP BY t."videoId", a.id, t."durationSec", t."createTime", w.handle
        ORDER BY t."videoId"
      `);
    }, { timeout: 25000 });
    const output = path.resolve("reports/video-evidence/large");
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(path.join(output, "inventory.json"), JSON.stringify({
      snapshotAt: new Date().toISOString(), targetId: "cmmtp8vrg0004mo381neyztvn",
      classification: "internal", items,
    }, null, 2) + "\n", { mode: 0o600 });
    console.log(`評価の母集団 ${items.length}本を保存。正解ラベルの自動生成はしていません。`);
  } finally { await db.$disconnect(); }
}

main().catch(() => { console.error("母集団の読み取りに失敗しました。接続先・分類・DBの制限を確認してください。"); process.exitCode = 1; });
