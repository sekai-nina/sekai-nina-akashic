/**
 * 服装スケッチの生成・確定 (#108)。
 *
 * ドシエの画像を参照に候補を作り、人が 1 枚選んで確定する。確定したものが記事のサムネになる。
 * 画像の取得・生成・R2 への保存は**トランザクションの外**で行う (数十秒かかるため)。
 */

import { withClearance, withSession } from "@/lib/db";
import { classificationFilter } from "@/lib/classification";
import {
  MAX_SKETCH_SOURCES,
  maxReferencePhotos,
  MAX_EXTERNAL_AI_CLEARANCE,
  sketchCandidateKeys,
} from "@/lib/meetgreet/config";
import {
  generateSketches,
  loadAssetImage,
  loadR2Image,
  type GeneratedSketch,
} from "@/lib/meetgreet/sketch";
import type { SketchSourceAsset } from "@/lib/meetgreet/types";
import { logAudit } from "./audit";
import { MeetGreetInputError, type ActingUser } from "./meetgreets";

/**
 * スケッチの参照に使えるドシエ内の画像。
 * 外部 AI に渡すので `MAX_EXTERNAL_AI_CLEARANCE` を超えるものは最初から出さない。
 */
export async function listSketchSources(
  user: ActingUser,
  meetGreet: { dossierId: string }
): Promise<SketchSourceAsset[]> {
  const items = await withSession(user, (tx) =>
    tx.dossierItem.findMany({
      where: {
        dossierId: meetGreet.dossierId,
        asset: { kind: "image", ...classificationFilter(MAX_EXTERNAL_AI_CLEARANCE) },
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      // 同じアセットが複数 item になることがあるので多めに取ってから畳む
      take: MAX_SKETCH_SOURCES * 2,
      select: { asset: { select: { id: true, title: true, kind: true, thumbnailUrl: true } } },
    })
  );

  const seen = new Set<string>();
  const out: SketchSourceAsset[] = [];
  for (const it of items) {
    const a = it.asset;
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push({ id: a.id, title: a.title, kind: a.kind, thumbnailUrl: a.thumbnailUrl });
    if (out.length >= MAX_SKETCH_SOURCES) break;
  }
  return out;
}

export interface GenerateSketchOptions {
  assetIds: string[];
  /** 作り直すときの元候補 (R2 key) */
  revisionOf?: string;
  revisionNote?: string;
}

/**
 * 候補を生成して `sketchCandidates` に積む。確定はしない。
 *
 * 参照にできるのは**このドシエに入っている画像**だけ (任意のアセットを外部に送らせない)。
 * 作り直しのときは直したい候補を 1 枚足すので、写真の上限がその分下がる (合計 16 枚)。
 */
export async function generateSketch(
  user: ActingUser,
  meetGreet: { id: string; dossierId: string; extraSketchPrompt: string; sketchCandidates: unknown },
  options: GenerateSketchOptions
): Promise<{ candidates: GeneratedSketch[]; usedPhotos: number }> {
  const ids = [...new Set(options.assetIds)];
  const limit = maxReferencePhotos(!!options.revisionOf);
  if (ids.length === 0) throw new MeetGreetInputError("参照にする写真を選んでください");
  if (ids.length > limit) {
    throw new MeetGreetInputError(
      options.revisionOf
        ? `作り直しでは直す候補の 1 枚を使うので、参照にできる写真は ${limit} 枚までです`
        : `参照にできる写真は ${limit} 枚までです`
    );
  }

  const known = sketchCandidateKeys(meetGreet.sketchCandidates);
  if (options.revisionOf && !known.includes(options.revisionOf)) {
    throw new MeetGreetInputError("作り直しの元にする候補が見つかりません");
  }

  const assets = await withSession(user, (tx) =>
    tx.asset.findMany({
      where: {
        id: { in: ids },
        kind: "image",
        ...classificationFilter(MAX_EXTERNAL_AI_CLEARANCE),
        dossierItems: { some: { dossierId: meetGreet.dossierId } },
      },
      select: { id: true, storageProvider: true, storageKey: true, thumbnailUrl: true },
    })
  );
  if (assets.length === 0) throw new MeetGreetInputError("ドシエにある画像を選んでください");

  const photos = (await Promise.all(assets.map((a) => loadAssetImage(a)))).filter(
    (p): p is NonNullable<typeof p> => p !== null
  );
  if (photos.length === 0) throw new MeetGreetInputError("参照画像を取得できませんでした");

  const revisionOf = options.revisionOf
    ? await loadR2Image(options.revisionOf, "previous-draft.png")
    : undefined;

  const candidates = await generateSketches({
    meetGreetId: meetGreet.id,
    photos,
    extraPrompt: meetGreet.extraSketchPrompt,
    revisionOf,
    revisionNote: options.revisionNote,
  });

  // 同時に 2 回生成されても取りこぼさないよう、読み書きではなく jsonb の追記で足す
  await withClearance(user.clearance, (tx) =>
    tx.$executeRaw`
      UPDATE "MeetGreet"
      SET "sketchCandidates" = "sketchCandidates" || ${JSON.stringify(
        candidates.map((c) => c.key)
      )}::jsonb,
          "updatedAt" = NOW()
      WHERE id = ${meetGreet.id}
    `
  );

  await logAudit({
    actorId: user.id,
    action: "meetgreet.sketch.generate",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: {
      requested: ids.length,
      photos: photos.length,
      generated: candidates.length,
      revision: !!options.revisionOf,
    },
  });
  return { candidates, usedPhotos: photos.length };
}

/** 候補の 1 枚を確定する (記事のサムネになる) */
export async function selectSketch(
  user: ActingUser,
  meetGreet: { id: string; sketchCandidates: unknown },
  key: string
) {
  if (!sketchCandidateKeys(meetGreet.sketchCandidates).includes(key)) {
    throw new MeetGreetInputError("その候補は見つかりません");
  }

  await withClearance(user.clearance, (tx) =>
    tx.meetGreet.update({ where: { id: meetGreet.id }, data: { sketchKey: key } })
  );
  await logAudit({
    actorId: user.id,
    action: "meetgreet.sketch.select",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: { key },
  });
}
