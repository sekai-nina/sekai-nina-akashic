/** 評価用の元動画と参照を読み取り専用で手元に保存する。本番の顔・タグには書かない。 */
import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { downloadFromDrive } from "../src/lib/drive";

type Label = { videoId: string; targetId: string; groupId: string; split: string; label: boolean | null; labelSource: string | null };
type Video = { videoId: string; assetId: string; durationSec: number | null; fileSize: number; storageKey: string };
type Reference = { id: string; assetId: string; modelVersion: string; status: string;
  predictedEntityId: string | null; confirmedEntityId: string | null; embedding: Uint8Array };

class EvaluationInputError extends Error {}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new EvaluationInputError(`${name} に値が必要です`);
    return args[index + 1];
  };
  if (args.includes("--help")) {
    console.log("pnpm exec tsx scripts/export-video-evidence.ts [--labels data/video-evidence-labels.jsonl] [--out reports/video-evidence]");
    return;
  }
  const output = path.resolve(option("--out", "reports/video-evidence"));
  const maxVideos = Number(option("--max-videos", "50"));
  if (!Number.isInteger(maxVideos) || maxVideos < 1 || maxVideos > 1000) throw new EvaluationInputError("max-videos は1〜1000にする");
  const labels: Label[] = (await readFile(option("--labels", "data/video-evidence-labels.jsonl"), "utf8"))
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Label);
  if (labels.length < 1 || labels.length > maxVideos || labels.some((label) => !/^\d{10,25}$/.test(label.videoId))) {
    throw new EvaluationInputError(`評価用の動画IDを1〜${maxVideos}件指定してください`);
  }
  if (!process.env.DIRECT_URL) throw new EvaluationInputError("DIRECT_URL が必要です。DATABASE_URL へはフォールバックしません");
  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
  try {
    const snapshot = new Date();
    const { videos, references } = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '20000ms'");
      const videos = await tx.$queryRaw<Video[]>(Prisma.sql`
        SELECT t."videoId", a.id AS "assetId", t."durationSec", a."fileSize", a."storageKey"
        FROM "TiktokVideo" t JOIN "Asset" a ON a.id = t."assetId"
        WHERE t."videoId" IN (${Prisma.join(labels.map((label) => label.videoId))})
          AND a.classification IN ('public', 'internal') AND t.classification IN ('public', 'internal')
          AND a.kind = 'video' AND a."storageProvider" = 'gdrive' AND a."storageKey" IS NOT NULL
      `);
      if (videos.length !== new Set(labels.map((label) => label.videoId)).size) {
        throw new EvaluationInputError("評価用の動画が未登録か、public / internal の読み取り対象外です");
      }
      for (const video of videos) {
        if (!video.fileSize || video.fileSize <= 0 || video.fileSize > 200_000_000) throw new EvaluationInputError("元動画は200MB以下にしてください");
      }
      if (videos.reduce((sum, video) => sum + Number(video.fileSize), 0) > 2_000_000_000) {
        throw new EvaluationInputError("取得する元動画の合計が2GBを超えています。対象を分割してください");
      }
      const assetIds = videos.map((video) => video.assetId);
      const references: Reference[] = [];
      let cursor = "";
      while (true) {
        const batch = await tx.$queryRaw<Reference[]>(Prisma.sql`
        SELECT f.id, f."assetId", f."modelVersion", f.status, f."predictedEntityId", f."confirmedEntityId", f.embedding
        FROM "FaceDetection" f JOIN "Asset" a ON a.id = f."assetId"
        WHERE a.classification IN ('public', 'internal') AND f.status IN ('confirmed', 'rejected')
          AND f."modelVersion" IN ('buffalo_l@1', 'buffalo_l@2', 'buffalo_l@3')
          AND f."assetId" NOT IN (${Prisma.join(assetIds)})
          AND (f."confirmedEntityId" IS NOT NULL OR (f.status = 'rejected' AND f."predictedEntityId" IS NOT NULL))
          AND f.id > ${cursor}
        ORDER BY f.id LIMIT 500
      `);
        references.push(...batch);
        if (references.length > 25000) throw new EvaluationInputError("参照が25000件を超えました。上限を確認してください");
        if (batch.length < 500) break;
        cursor = batch[batch.length - 1].id;
      }
      return { videos, references };
    }, { timeout: 120000 });
    await mkdir(output, { recursive: true, mode: 0o700 });
    const refText = references.map((ref) => JSON.stringify({ ...ref,
      embedding: Buffer.from(ref.embedding).toString("base64") })).join("\n") + "\n";
    const referenceHash = createHash("sha256").update(refText).digest("hex");
    await writeFile(path.join(output, "references.jsonl"), refText, { mode: 0o600 });
    const manifest: { videoId: string; assetId: string; durationSec: number | null; filename: string; size: number; sha256: string }[] = [];
    const queue = [...videos];
    let stopped = false;
    async function downloadNext() {
      while (queue.length && !stopped) {
        const video = queue.shift();
        if (!video) return;
        try {
          const filename = `${video.videoId}.mp4`;
          const destination = path.join(output, filename);
          let bytes: Buffer | null = null;
          try {
            if ((await stat(destination)).size === Number(video.fileSize)) bytes = await readFile(destination);
          } catch { /* 未取得なら Drive から1回だけ取る */ }
          if (!bytes) bytes = await downloadFromDrive(video.storageKey, { timeoutMs: 60000 });
          if (!bytes || bytes.length !== Number(video.fileSize)) throw new EvaluationInputError(`動画 ${video.videoId} の取得サイズが一致しません`);
          await writeFile(destination, bytes, { mode: 0o600 });
          manifest.push({ videoId: video.videoId, assetId: video.assetId, durationSec: video.durationSec,
            filename, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
          console.log(`動画 ${video.videoId}: ${bytes.length} bytes 保存済み`);
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    }
    // 最大4件だけ並列化する。1件失敗したら新規取得を止め、進行中の取得が終わるまで待つ。
    const downloads = await Promise.allSettled(Array.from({ length: Math.min(4, videos.length) }, downloadNext));
    const failed = downloads.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    manifest.sort((a, b) => a.videoId.localeCompare(b.videoId));
    await writeFile(path.join(output, "manifest.json"), JSON.stringify({
      snapshotAt: snapshot.toISOString(), referencesSha256: referenceHash,
      excludedAssetIds: videos.map((video) => video.assetId), videos: manifest,
      referenceCount: references.length, classification: "internal",
    }, null, 2) + "\n", { mode: 0o600 });
    console.log(`参照 ${references.length}件・動画 ${manifest.length}本。DB・Drive は読み取りのみ。`);
  } finally { await db.$disconnect(); }
}

main().catch((error: unknown) => {
  // HTTP / DB 例外の本文には接続情報や署名付きURLが入ることがあるので出さない。
  if (error instanceof EvaluationInputError) console.error(error.message);
  else if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const databaseCode = String(error.meta?.code ?? "");
    console.error("DB読み取りエラー:", error.code, /^[A-Z0-9]{5}$/.test(databaseCode) ? databaseCode : "");
  } else console.error("評価データの取得エラー:", error instanceof Error ? error.name : "unknown");
  process.exitCode = 1;
});
