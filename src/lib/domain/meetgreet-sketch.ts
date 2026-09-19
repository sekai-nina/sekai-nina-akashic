/**
 * 服装スケッチの生成・確定 (#108)。
 *
 * ドシエの画像を参照に候補を作り、人が 1 枚選んで確定する。確定したものが記事のサムネになる。
 * 画像の取得・生成・R2 への保存は**トランザクションの外**で行う (数十秒かかるため)。
 */

import { Prisma } from "@prisma/client";
import { withClearance, withSession } from "@/lib/db";
import { accessibleClassifications, classificationFilter } from "@/lib/classification";
import {
  MAX_SKETCH_SOURCES,
  maxReferencePhotos,
  MAX_EXTERNAL_AI_CLEARANCE,
  jsonStringArray,
} from "@/lib/meetgreet/config";
import {
  generateSketches,
  loadAssetImage,
  loadR2Image,
  loadR2Reference,
  type GeneratedSketch,
} from "@/lib/meetgreet/sketch";
import { cropsFromJson, withCrops, type CropMap, type CropRect } from "@/lib/meetgreet/crop";
import { deleteFromR2 } from "@/lib/r2";
import {
  isRefKeyOf,
  refsFromJson,
  MAX_SKETCH_REFS,
  type SketchRef,
} from "@/lib/meetgreet/sketch-refs";
import type { SketchSourceAsset } from "@/lib/meetgreet/types";
import { logAudit } from "./audit";
import { getSketchSetting } from "./sketch-setting";
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
  /** その回だけの参考画像 (#159)。`sketchRefs` の key */
  refKeys?: string[];
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
  meetGreet: {
    id: string;
    dossierId: string;
    extraSketchPrompt: string;
    sketchCandidates: unknown;
    /** その回だけの参考画像 (#159) */
    sketchRefs: unknown;
    /** 外部 AI に出してよい回か見る (#159) */
    classification: string;
    /** 参照写真の切り抜き枠 (#136) */
    sketchCrops: unknown;
  },
  options: GenerateSketchOptions
): Promise<{ candidates: GeneratedSketch[]; usedPhotos: number }> {
  // **ミーグリ自身の機密も見る (#159)。** アップロードした参考画像にはアセット側の
  // 検査が無いので、ここが唯一の歯止めになる。生成したスケッチは公開 URL の R2 に置かれる
  const allowed: readonly string[] = accessibleClassifications(MAX_EXTERNAL_AI_CLEARANCE);
  if (!allowed.includes(meetGreet.classification)) {
    throw new MeetGreetInputError(
      "この回は機密レベルが高いため、外部 AI でスケッチを作れません"
    );
  }

  const ids = [...new Set(options.assetIds)];
  const refKeys = [...new Set(options.refKeys ?? [])];
  const knownRefs = refsFromJson(meetGreet.sketchRefs).map((r) => r.key);
  const unknownRef = refKeys.find((k) => !knownRefs.includes(k));
  if (unknownRef) throw new MeetGreetInputError("参考画像が見つかりません");

  const limit = maxReferencePhotos(!!options.revisionOf);
  if (ids.length + refKeys.length === 0) {
    throw new MeetGreetInputError("参照にする写真を選んでください");
  }
  if (ids.length + refKeys.length > limit) {
    throw new MeetGreetInputError(
      options.revisionOf
        ? `作り直しでは直す候補の 1 枚を使うので、参照にできる写真は ${limit} 枚までです`
        : `参照にできる写真は ${limit} 枚までです`
    );
  }

  const knownCandidates = jsonStringArray(meetGreet.sketchCandidates);
  if (options.revisionOf && !knownCandidates.includes(options.revisionOf)) {
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
  if (assets.length === 0 && refKeys.length === 0) {
    throw new MeetGreetInputError("ドシエにある画像を選んでください");
  }

  // 切り抜き枠があれば、その範囲だけを送る (ツーショットで隣の人を拾わないように)。
  // アップロードした参考画像も同じ枠の仕組みに乗る (キーは R2 key)
  const crops = cropsFromJson(meetGreet.sketchCrops);
  const photos = (
    await Promise.all([
      ...assets.map((a) => loadAssetImage(a, crops[a.id])),
      ...refKeys.map((k) => loadR2Reference(k, crops[k])),
    ])
  ).filter((p): p is NonNullable<typeof p> => p !== null);
  if (photos.length === 0) throw new MeetGreetInputError("参照画像を取得できませんでした");

  const revisionOf = options.revisionOf
    ? await loadR2Image(options.revisionOf, "previous-draft.png")
    : undefined;

  // プロンプトと画風の見本は画面から直せる (#136)。未設定なら組み込みの既定
  const setting = await getSketchSetting();
  const candidates = await generateSketches({
    meetGreetId: meetGreet.id,
    photos,
    extraPrompt: meetGreet.extraSketchPrompt,
    revisionOf,
    revisionNote: options.revisionNote,
    basePrompt: setting.prompt,
    styleReferenceKey: setting.styleReferenceKey,
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
      refs: refKeys.length,
      photos: photos.length,
      generated: candidates.length,
      revision: !!options.revisionOf,
      cropped: ids.filter((id) => crops[id]).length,
      customPrompt: !setting.isDefaultPrompt,
      customStyleReference: !setting.isDefaultStyleReference,
    },
  });
  return { candidates, usedPhotos: photos.length };
}

/**
 * その回だけの参考画像を覚える (#159)。R2 への保存は呼び出し側 (API route) が済ませている。
 *
 * **この回の置き場の key しか受け取らない。** R2 の任意のオブジェクトを参照に仕立てられると、
 * 見えないはずの画像を外部 AI に送る口になる (基準スケッチの差し替えと同じ考え方)。
 */
export async function addSketchRef(
  user: ActingUser,
  meetGreet: { id: string; sketchRefs: unknown },
  ref: SketchRef
): Promise<SketchRef[]> {
  if (!isRefKeyOf(meetGreet.id, ref.key)) {
    throw new MeetGreetInputError("この回の参考画像ではありません");
  }
  const current = refsFromJson(meetGreet.sketchRefs);
  if (current.length >= MAX_SKETCH_REFS) {
    throw new MeetGreetInputError(`参考画像は ${MAX_SKETCH_REFS} 枚までです`);
  }
  const next = [...current.filter((r) => r.key !== ref.key), ref];
  await withClearance(user.clearance, (tx) =>
    tx.meetGreet.update({
      where: { id: meetGreet.id },
      data: { sketchRefs: next as unknown as Prisma.InputJsonValue },
    })
  );
  await logAudit({
    actorId: user.id,
    action: "meetgreet.sketch.ref.add",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: { key: ref.key, name: ref.name },
  });
  return next;
}

/** 参考画像を消す (#159)。R2 の実体も消す */
export async function removeSketchRef(
  user: ActingUser,
  meetGreet: { id: string; sketchRefs: unknown; sketchCrops: unknown },
  key: string
): Promise<SketchRef[]> {
  const current = refsFromJson(meetGreet.sketchRefs);
  if (!current.some((r) => r.key === key)) {
    throw new MeetGreetInputError("参考画像が見つかりません");
  }
  const next = current.filter((r) => r.key !== key);
  // 枠も一緒に落とす (宙に浮いた枠が Json に残り続けないように)
  const crops = withCrops(cropsFromJson(meetGreet.sketchCrops), { [key]: null });
  await withClearance(user.clearance, (tx) =>
    tx.meetGreet.update({
      where: { id: meetGreet.id },
      data: {
        sketchRefs: next as unknown as Prisma.InputJsonValue,
        sketchCrops: crops as unknown as Prisma.InputJsonValue,
      },
    })
  );
  // **R2 の実体は DB の更新が済んでから消す。** 先に消すと、更新に失敗したときに
  // 一覧には残っているのに開けない参考画像になる
  try {
    await deleteFromR2(key);
  } catch {
    // 実体が消えなくても一覧から外れていればよい (次の生成では使われない)
  }
  await logAudit({
    actorId: user.id,
    action: "meetgreet.sketch.ref.remove",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: { key },
  });
  return next;
}

/**
 * 参照写真の切り抜き枠を保存する (#136)。
 *
 * **このドシエにある画像だけ。** 任意のアセット ID で枠を溜められると、
 * 生成のたびに読む Json が無関係なもので膨らむ。`null` を渡すと枠を外す。
 */
export async function saveSketchCrops(
  user: ActingUser,
  meetGreet: { id: string; dossierId: string; sketchCrops: unknown; sketchRefs: unknown },
  changes: Record<string, CropRect | null>
): Promise<CropMap> {
  const ids = Object.keys(changes);
  if (ids.length === 0) return cropsFromJson(meetGreet.sketchCrops);
  if (ids.length > MAX_SKETCH_SOURCES) {
    throw new MeetGreetInputError(`一度に指定できるのは ${MAX_SKETCH_SOURCES} 枚までです`);
  }

  // **消す指定はドシエの中身を見ない。** ドシエから外した画像の枠が永久に消せなくなる。
  // その回の参考画像 (#159) はアセットではないので、ここで先に外しておく
  const refKeys = new Set(refsFromJson(meetGreet.sketchRefs).map((r) => r.key));
  const setIds = ids.filter((id) => changes[id] !== null && !refKeys.has(id));
  const known = await withSession(user, (tx) =>
    tx.asset.findMany({
      where: {
        id: { in: setIds },
        kind: "image",
        ...classificationFilter(MAX_EXTERNAL_AI_CLEARANCE),
        dossierItems: { some: { dossierId: meetGreet.dossierId } },
      },
      select: { id: true },
    })
  );
  const allowed = new Set(known.map((a) => a.id));
  if (setIds.some((id) => !allowed.has(id))) {
    throw new MeetGreetInputError("ドシエにある画像を選んでください");
  }

  const next = withCrops(cropsFromJson(meetGreet.sketchCrops), changes);
  await withClearance(user.clearance, (tx) =>
    tx.meetGreet.update({
      where: { id: meetGreet.id },
      data: { sketchCrops: next as unknown as Prisma.InputJsonValue },
    })
  );
  await logAudit({
    actorId: user.id,
    action: "meetgreet.sketch.crop",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: { set: ids.filter((id) => changes[id] !== null), cleared: ids.filter((id) => changes[id] === null) },
  });
  return next;
}

/** 候補の 1 枚を確定する (記事のサムネになる) */
export async function selectSketch(
  user: ActingUser,
  meetGreet: { id: string; sketchCandidates: unknown },
  key: string
) {
  if (!jsonStringArray(meetGreet.sketchCandidates).includes(key)) {
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
