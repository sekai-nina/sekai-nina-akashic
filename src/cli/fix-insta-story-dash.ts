/**
 * 一度きりの後片付け: DASH で割れたまま登録された story のアセットを結合して差し替える (#201)。
 *
 * #201 より前は、Instagram の DASH をそのまま登録していたため 1 コマが
 * 「映像だけ (VP9)」と「音声だけ (HE-AAC)」の 2 アセットに割れていた。iPhone では再生できない。
 * 署名付きの CDN URL は切れているので取り直せないが、**Drive にある実体同士を結合**すれば直せる。
 *
 * Usage:
 *   pnpm cli:fix-insta-dash            # 下見 (何もしない)
 *   pnpm cli:fix-insta-dash --apply    # 実行
 *
 * やること (ジョブごと・登録順に対にする):
 *   - 映像のみ + 音声のみ → 結合して Drive に上げ、映像側のアセットを差し替え、音声側のアセットは削除
 *   - 相方がいない音声のみ → kind を audio に直すだけ (消さない)
 *   - 既に両方入っているものは触らない
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prismaInternal } from "@/lib/db";
import { deleteAsset } from "@/lib/domain/assets";
import { downloadFromDrive, fetchDriveThumbnail, trashDriveFile, uploadToDrive } from "@/lib/drive";
import { muxVideoAudio, probeMedia } from "@/lib/insta/transcode";
import { generateAndUploadThumbnails } from "@/lib/thumbnails";

const APPLY = process.argv.includes("--apply");
/** 消す側のアセットを削除するときのクリアランス (CLI なので最上位で通す) */
const CLEARANCE = "restricted";

interface Target {
  id: string;
  title: string;
  kind: string;
  mimeType: string | null;
  storageKey: string | null;
  fileSize: number | null;
  createdAt: Date;
  jobId: string;
}

async function main() {
  if (!process.env.DIRECT_URL?.trim()) {
    console.error("DIRECT_URL が未設定です (素の DATABASE_URL だと RLS で 0 行になる)");
    process.exit(1);
  }

  // ジョブの result.files から辿る (到着順が分かるので、対にする根拠が登録時と同じになる)
  const jobs = await prismaInternal.instaStoryJob.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, result: true },
  });

  const byJob = new Map<string, Target[]>();
  for (const job of jobs) {
    const files = ((job.result as { files?: unknown[] } | null)?.files ?? []) as Record<string, unknown>[];
    const ids = files.map((f) => f.assetId).filter((v): v is string => typeof v === "string");
    if (ids.length === 0) continue;
    const assets = await prismaInternal.asset.findMany({
      where: { id: { in: ids }, kind: { in: ["video", "audio"] } },
      select: {
        id: true,
        title: true,
        kind: true,
        mimeType: true,
        storageKey: true,
        fileSize: true,
        createdAt: true,
      },
    });
    // result の並び (到着順) にそろえる
    const order = new Map(ids.map((id, i) => [id, i]));
    const list = assets
      .filter((a) => a.storageKey)
      .sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0))
      .map((a) => ({ ...a, jobId: job.id }));
    if (list.length > 0) byJob.set(job.id, list);
  }
  const total = [...byJob.values()].reduce((n, l) => n + l.length, 0);
  console.log(`story ジョブ ${byJob.size} 件 / 動画・音声として登録されたアセット ${total} 件を見る`);

  let merged = 0;
  let relabeled = 0;
  let skipped = 0;
  for (const [jobId, list] of byJob) {
    const videos: { t: Target; buf: Buffer }[] = [];
    const audios: { t: Target; buf: Buffer }[] = [];
    for (const t of list) {
      const buf = await downloadFromDrive(t.storageKey!).catch(() => null);
      if (!buf) {
        console.log(`  ! ${t.id} 実体を読めない (storageKey=${t.storageKey}) → 飛ばす`);
        continue;
      }
      const { hasVideo, hasAudio } = await probeMedia(buf, `${t.id}.mp4`);
      if (hasVideo && hasAudio) {
        skipped += 1;
        continue;
      }
      if (hasVideo) videos.push({ t, buf });
      else if (hasAudio) audios.push({ t, buf });
      else console.log(`  ! ${t.id} 映像も音声も無い → 飛ばす`);
    }
    if (videos.length === 0 && audios.length === 0) continue;
    console.log(`\njob ${jobId.slice(-6)}: 映像のみ ${videos.length} / 音声のみ ${audios.length}`);

    const pairs = Math.min(videos.length, audios.length);
    for (let i = 0; i < pairs; i += 1) {
      const v = videos[i];
      const a = audios[i];
      console.log(`  結合: ${v.t.id} (${v.buf.length}B) + ${a.t.id} (${a.buf.length}B)`);
      if (!APPLY) {
        merged += 1;
        continue;
      }
      const muxedBuf = await muxVideoAudio(v.buf, a.buf, `${v.t.id}.mp4`);
      const sha256 = createHash("sha256").update(muxedBuf).digest("hex");
      const uploaded = await uploadToDrive(muxedBuf, `${v.t.title || v.t.id}.mp4`, "video/mp4");
      if (!uploaded) {
        console.log("   ! Drive に上げられなかった → 飛ばす");
        continue;
      }
      const oldKey = v.t.storageKey!;
      await prismaInternal.asset.update({
        where: { id: v.t.id },
        data: {
          storageProvider: "gdrive",
          storageKey: uploaded.fileId,
          storageUrl: uploaded.webViewLink,
          sha256,
          fileSize: muxedBuf.length,
          mimeType: "video/mp4",
          kind: "video",
        },
      });
      // サムネイルは Drive の生成物から。直後は無いことがあるので失敗は許す
      try {
        const thumb = await fetchDriveThumbnail(uploaded.fileId);
        const r2 = thumb ? await generateAndUploadThumbnails(v.t.id, thumb) : null;
        if (r2) await prismaInternal.asset.update({ where: { id: v.t.id }, data: { thumbnailUrl: r2 } });
      } catch (e) {
        console.log("   (サムネイルは後で cli:thumbnails --kind=video で埋める)", (e as Error).message);
      }
      // 古い実体はゴミ箱へ。音声側のアセットは消す
      await trashDriveFile(oldKey).catch((e) => console.log("   古い映像の片付けに失敗:", (e as Error).message));
      const audioKey = a.t.storageKey!;
      await deleteAsset(a.t.id, null, CLEARANCE);
      await trashDriveFile(audioKey).catch((e) => console.log("   音声の片付けに失敗:", (e as Error).message));
      await dropFromJobResult(jobId, a.t.id);
      await updateJobResult(jobId, v.t.id, { sha256, fileSize: muxedBuf.length, driveFileId: uploaded.fileId });
      merged += 1;
      console.log(`   → ${v.t.id} を差し替え (${muxedBuf.length}B) / ${a.t.id} を削除`);
    }

    // 相方がいない音声のみは「動画」をやめるだけ
    for (const a of audios.slice(pairs)) {
      console.log(`  音声として直す: ${a.t.id}`);
      relabeled += 1;
      if (!APPLY) continue;
      await prismaInternal.asset.update({
        where: { id: a.t.id },
        data: { kind: "audio", mimeType: "audio/mp4" },
      });
    }
    for (const v of videos.slice(pairs)) {
      console.log(`  相方の音声が無い映像 (そのまま): ${v.t.id}`);
    }
  }

  console.log(
    `\n${APPLY ? "完了" : "下見"}: 結合 ${merged} 組 / 音声に直す ${relabeled} 件 / 触らない ${skipped} 件`,
  );
  if (!APPLY) console.log("実行するには --apply を付ける");
}

/** ジョブの result から消したアセットの行を落とす */
async function dropFromJobResult(jobId: string, assetId: string) {
  const job = await prismaInternal.instaStoryJob.findUnique({ where: { id: jobId }, select: { result: true } });
  const files = ((job?.result as { files?: unknown[] } | null)?.files ?? []) as Record<string, unknown>[];
  const next = files.filter((f) => f.assetId !== assetId);
  await prismaInternal.instaStoryJob.update({
    where: { id: jobId },
    data: { result: { files: next } as unknown as Prisma.InputJsonValue },
  });
}

/** 差し替えた実体の情報をジョブの result にも反映する */
async function updateJobResult(
  jobId: string,
  assetId: string,
  patch: { sha256: string; fileSize: number; driveFileId: string },
) {
  const job = await prismaInternal.instaStoryJob.findUnique({ where: { id: jobId }, select: { result: true } });
  const files = ((job?.result as { files?: unknown[] } | null)?.files ?? []) as Record<string, unknown>[];
  const next = files.map((f) => (f.assetId === assetId ? { ...f, ...patch, mimeType: "video/mp4" } : f));
  await prismaInternal.instaStoryJob.update({
    where: { id: jobId },
    data: { result: { files: next } as unknown as Prisma.InputJsonValue },
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prismaInternal.$disconnect());
