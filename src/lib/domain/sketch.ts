/**
 * 服装 / 衣装スケッチの生成・確定 (#108 → #150 でミーグリとライブの共用に)。
 *
 * ドシエの画像を参照に候補を作り、人が 1 枚選んで確定する。確定したものが記事のサムネになる。
 * 画像の取得・生成・R2 への保存は**トランザクションの外**で行う (数十秒かかるため)。
 *
 * 器 (MeetGreet / Live) ごとに違うのは「どのテーブルに書くか」「エラーの型」「R2 の置き場」
 * だけなので、それを `SketchStore` に寄せ、処理本体はここに 1 つだけ持つ。
 * ミーグリ側の入口は meetgreet-sketch.ts、ライブ側は live-sketch.ts (どちらも薄い)。
 */

import { Prisma } from "@prisma/client";
import { withClearance, withSession, type TransactionClient } from "@/lib/db";
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
import { sketchAddendumFor } from "@/lib/meetgreet/sketch-prompt";
import { deleteFromR2 } from "@/lib/r2";
import {
  isRefKeyOf,
  refsFromJson,
  sketchKeyPrefix,
  MAX_SKETCH_REFS,
  type SketchOwnerKind,
  type SketchRef,
} from "@/lib/meetgreet/sketch-refs";
import type { SketchSourceAsset } from "@/lib/meetgreet/types";
import { logAudit } from "./audit";
import { getSketchSetting } from "./sketch-setting";
import { WorkflowInputError, type ActingUser } from "./article-workflow";

/** スケッチを持つ器の、生成に要る列 */
export interface SketchOwner {
  id: string;
  dossierId: string;
  /** 外部 AI に出してよい器か見る (#159) */
  classification: string;
  extraSketchPrompt: string;
  sketchCandidates: unknown;
  /** その器だけの参考画像 (#159) */
  sketchRefs: unknown;
  /** 参照写真の切り抜き枠 (#136) */
  sketchCrops: unknown;
}

/** 器ごとの書き込み先と名前 */
export interface SketchStore {
  kind: SketchOwnerKind;
  /** 監査ログの targetType (`MeetGreet` / `Live`) */
  targetType: string;
  /** エラー文に出す器の呼び名 (ミーグリは 1 回分を「回」、ライブは「ライブ」) */
  noun: string;
  /** 器ごとの入力エラー (REST が 400 にする) */
  inputError: new (message: string) => WorkflowInputError;
  /** 候補の key を jsonb に追記する (同時に 2 回生成されても取りこぼさない) */
  appendCandidates(tx: TransactionClient, id: string, keys: string[]): Promise<void>;
  readRefs(tx: TransactionClient, id: string): Promise<unknown>;
  update(
    tx: TransactionClient,
    id: string,
    data: { sketchRefs?: unknown; sketchCrops?: unknown; sketchKey?: string }
  ): Promise<void>;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/**
 * スケッチの参照に使えるドシエ内の画像。
 * 外部 AI に渡すので `MAX_EXTERNAL_AI_CLEARANCE` を超えるものは最初から出さない。
 */
export async function listSketchSources(
  user: ActingUser,
  owner: { dossierId: string }
): Promise<SketchSourceAsset[]> {
  const items = await withSession(user, (tx) =>
    tx.dossierItem.findMany({
      where: {
        dossierId: owner.dossierId,
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
  /** その器だけの参考画像 (#159)。`sketchRefs` の key */
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
  store: SketchStore,
  user: ActingUser,
  owner: SketchOwner,
  options: GenerateSketchOptions
): Promise<{ candidates: GeneratedSketch[]; usedPhotos: number }> {
  const Err = store.inputError;
  // **器自身の機密も見る (#159)。** アップロードした参考画像にはアセット側の
  // 検査が無いので、ここが唯一の歯止めになる。生成したスケッチは公開 URL の R2 に置かれる
  const allowed: readonly string[] = accessibleClassifications(MAX_EXTERNAL_AI_CLEARANCE);
  if (!allowed.includes(owner.classification)) {
    throw new Err(`この${store.noun}は機密レベルが高いため、外部 AI でスケッチを作れません`);
  }

  const ids = [...new Set(options.assetIds)];
  const refKeys = [...new Set(options.refKeys ?? [])];
  // 置き場も一緒に確かめる (同上。外部 AI に送る口なので二重に見る)
  const knownRefs = refsFromJson(owner.sketchRefs)
    .map((r) => r.key)
    .filter((k) => isRefKeyOf(store.kind, owner.id, k));
  const unknownRef = refKeys.find((k) => !knownRefs.includes(k));
  if (unknownRef) throw new Err("参考画像が見つかりません");

  const limit = maxReferencePhotos(!!options.revisionOf);
  if (ids.length + refKeys.length === 0) {
    throw new Err("参照にする写真を選んでください");
  }
  if (ids.length + refKeys.length > limit) {
    throw new Err(
      options.revisionOf
        ? `作り直しでは直す候補の 1 枚を使うので、参照にできる写真は ${limit} 枚までです`
        : `参照にできる写真は ${limit} 枚までです`
    );
  }

  const knownCandidates = jsonStringArray(owner.sketchCandidates);
  if (options.revisionOf && !knownCandidates.includes(options.revisionOf)) {
    throw new Err("作り直しの元にする候補が見つかりません");
  }

  const assets = await withSession(user, (tx) =>
    tx.asset.findMany({
      where: {
        id: { in: ids },
        kind: "image",
        ...classificationFilter(MAX_EXTERNAL_AI_CLEARANCE),
        dossierItems: { some: { dossierId: owner.dossierId } },
      },
      select: { id: true, storageProvider: true, storageKey: true, thumbnailUrl: true },
    })
  );
  // 指定したのに 1 枚も取れないのは、機密かドシエ外を選んでいる。黙って残りで作らない
  if (ids.length > 0 && assets.length === 0) {
    throw new Err("ドシエにある画像を選んでください");
  }

  // 切り抜き枠があれば、その範囲だけを送る (ツーショットで隣の人を拾わないように)。
  // アップロードした参考画像も同じ枠の仕組みに乗る (キーは R2 key)
  const crops = cropsFromJson(owner.sketchCrops);
  const photos = (
    await Promise.all([
      ...assets.map((a) => loadAssetImage(a, crops[a.id])),
      ...refKeys.map((k) => loadR2Reference(k, crops[k])),
    ])
  ).filter((p): p is NonNullable<typeof p> => p !== null);
  if (photos.length === 0) throw new Err("参照画像を取得できませんでした");

  const revisionOf = options.revisionOf
    ? await loadR2Image(options.revisionOf, "previous-draft.png")
    : undefined;

  // プロンプトと画風の見本は画面から直せる (#136)。未設定なら組み込みの既定。
  // ライブは「ステージ衣装である」旨を追加指示の先頭に足す (本体は私服向けに書かれている)
  const setting = await getSketchSetting();
  const extraPrompt = [sketchAddendumFor(store.kind), owner.extraSketchPrompt].filter((s) => s.trim()).join("\n");
  const candidates = await generateSketches({
    keyPrefix: sketchKeyPrefix(store.kind, owner.id),
    photos,
    extraPrompt,
    revisionOf,
    revisionNote: options.revisionNote,
    basePrompt: setting.prompt,
    styleReferenceKey: setting.styleReferenceKey,
  });

  await withClearance(user.clearance, (tx) =>
    store.appendCandidates(
      tx,
      owner.id,
      candidates.map((c) => c.key)
    )
  );

  await logAudit({
    actorId: user.id,
    action: `${store.kind}.sketch.generate`,
    targetType: store.targetType,
    targetId: owner.id,
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
 * その器だけの参考画像を覚える (#159)。R2 への保存は呼び出し側 (API route) が済ませている。
 *
 * **この器の置き場の key しか受け取らない。** R2 の任意のオブジェクトを参照に仕立てられると、
 * 見えないはずの画像を外部 AI に送る口になる (基準スケッチの差し替えと同じ考え方)。
 */
export async function addSketchRef(
  store: SketchStore,
  user: ActingUser,
  owner: { id: string; sketchRefs: unknown },
  ref: SketchRef
): Promise<SketchRef[]> {
  const Err = store.inputError;
  if (!isRefKeyOf(store.kind, owner.id, ref.key)) {
    throw new Err(`この${store.noun}の参考画像ではありません`);
  }
  // **読み直してから足す。** 2 枚同時に上げると、古いスナップショットで書き戻して
  // 先に入ったほうが一覧から消える (R2 の実体だけ残って誰も参照しない)
  const next = await withClearance(user.clearance, async (tx) => {
    const current = refsFromJson(await store.readRefs(tx, owner.id));
    if (current.length >= MAX_SKETCH_REFS) {
      throw new Err(`参考画像は ${MAX_SKETCH_REFS} 枚までです`);
    }
    const merged = [...current.filter((r) => r.key !== ref.key), ref];
    await store.update(tx, owner.id, { sketchRefs: asJson(merged) });
    return merged;
  });
  await logAudit({
    actorId: user.id,
    action: `${store.kind}.sketch.ref.add`,
    targetType: store.targetType,
    targetId: owner.id,
    metadata: { key: ref.key, name: ref.name },
  });
  return next;
}

/** 参考画像を消す (#159)。R2 の実体も消す */
export async function removeSketchRef(
  store: SketchStore,
  user: ActingUser,
  owner: { id: string; sketchRefs: unknown; sketchCrops: unknown },
  key: string
): Promise<SketchRef[]> {
  const Err = store.inputError;
  const current = refsFromJson(owner.sketchRefs);
  if (!current.some((r) => r.key === key)) {
    throw new Err("参考画像が見つかりません");
  }
  // **Json 列の中身も信用しない。** いまの書き手は addSketchRef だけだが、
  // 復元や手直しで別の key が入ると「バケットの任意のオブジェクトを消す」になる
  if (!isRefKeyOf(store.kind, owner.id, key)) {
    throw new Err(`この${store.noun}の参考画像ではありません`);
  }
  const next = current.filter((r) => r.key !== key);
  // 枠も一緒に落とす (宙に浮いた枠が Json に残り続けないように)
  const crops = withCrops(cropsFromJson(owner.sketchCrops), { [key]: null });
  await withClearance(user.clearance, (tx) =>
    store.update(tx, owner.id, { sketchRefs: asJson(next), sketchCrops: asJson(crops) })
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
    action: `${store.kind}.sketch.ref.remove`,
    targetType: store.targetType,
    targetId: owner.id,
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
  store: SketchStore,
  user: ActingUser,
  owner: { id: string; dossierId: string; sketchCrops: unknown; sketchRefs: unknown },
  changes: Record<string, CropRect | null>
): Promise<CropMap> {
  const Err = store.inputError;
  const ids = Object.keys(changes);
  if (ids.length === 0) return cropsFromJson(owner.sketchCrops);
  if (ids.length > MAX_SKETCH_SOURCES) {
    throw new Err(`一度に指定できるのは ${MAX_SKETCH_SOURCES} 枚までです`);
  }

  // **消す指定はドシエの中身を見ない。** ドシエから外した画像の枠が永久に消せなくなる。
  // その器の参考画像 (#159) はアセットではないので、ここで先に外しておく
  const refKeys = new Set(refsFromJson(owner.sketchRefs).map((r) => r.key));
  const setIds = ids.filter((id) => changes[id] !== null && !refKeys.has(id));
  const known = await withSession(user, (tx) =>
    tx.asset.findMany({
      where: {
        id: { in: setIds },
        kind: "image",
        ...classificationFilter(MAX_EXTERNAL_AI_CLEARANCE),
        dossierItems: { some: { dossierId: owner.dossierId } },
      },
      select: { id: true },
    })
  );
  const allowedIds = new Set(known.map((a) => a.id));
  if (setIds.some((id) => !allowedIds.has(id))) {
    throw new Err("ドシエにある画像を選んでください");
  }

  const next = withCrops(cropsFromJson(owner.sketchCrops), changes);
  await withClearance(user.clearance, (tx) => store.update(tx, owner.id, { sketchCrops: asJson(next) }));
  await logAudit({
    actorId: user.id,
    action: `${store.kind}.sketch.crop`,
    targetType: store.targetType,
    targetId: owner.id,
    metadata: { set: ids.filter((id) => changes[id] !== null), cleared: ids.filter((id) => changes[id] === null) },
  });
  return next;
}

/** 候補の 1 枚を確定する (記事のサムネになる) */
export async function selectSketch(
  store: SketchStore,
  user: ActingUser,
  owner: { id: string; sketchCandidates: unknown },
  key: string
) {
  if (!jsonStringArray(owner.sketchCandidates).includes(key)) {
    throw new store.inputError("その候補は見つかりません");
  }

  await withClearance(user.clearance, (tx) => store.update(tx, owner.id, { sketchKey: key }));
  await logAudit({
    actorId: user.id,
    action: `${store.kind}.sketch.select`,
    targetType: store.targetType,
    targetId: owner.id,
    metadata: { key },
  });
}
