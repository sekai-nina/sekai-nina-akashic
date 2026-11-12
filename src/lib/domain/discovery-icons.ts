/**
 * 今日の発見の食べ物アイコン (#436) の DB 側。
 *
 * - 対象: 分類 (`DiscoveryFood`) のある名前のうち、**外部 AI に出してよいブログ (internal 以下) の発見に出てくる**もの。
 *   名前を OpenAI に送るので、機密の高いブログにしか出てこない名前は作らない (cron も確認ページも同じ線引き)
 * - cron (`/api/cron/discovery-icons`) と CLI (`pnpm cli:food-icons`) は、アイコンの無い名前に作る。
 *   作れなかった回数が上限に達した名前は cron から外す (人が確認ページで作り直すと 0 に戻る)
 * - 確認ページは、人の指示 (`iconNote`) を付けて作り直す。人が選ぶ段は無く、作ったものがサイトの次のビルドで出る
 *   (2026-11-12 に決めた)
 * - **前のアイコンは R2 から消さない。** サイトは R2 の URL をそのまま埋め込むので、消すと次のビルドまで画像が切れる
 *
 * `DiscoveryFood` は非保護テーブル (RLS は `USING (true)`)。発見 (`Discovery`) は保護テーブルなので、
 * 出てくるかどうかは RLS をバイパスする接続 + `classificationFilterSql` で確かめる。
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { classificationFilterSql } from "@/lib/classification";
import { prismaInternal, withClearance } from "@/lib/db";
import { deleteFromR2 } from "@/lib/r2";
import { MAX_EXTERNAL_AI_CLEARANCE } from "@/lib/meetgreet/config";
import { FOOD_CATEGORY_LABELS } from "@/lib/utils";
import { generateFoodIcon, loadFoodIconStyle } from "@/lib/discoveries/icon";
import type { SketchSourceImage } from "@/lib/meetgreet/sketch";

/** cron が 1 つの名前を試す回数の上限 */
export const FOOD_ICON_MAX_FAILURES = 3;
/** cron が 1 回に作る枚数。1 枚 15〜20 秒を並べて作るので、`maxDuration` に十分収まる */
export const FOOD_ICON_BATCH_SIZE = 4;

export interface FoodIconTarget {
  name: string;
  category: string;
  iconKey: string;
  iconNote: string;
}

/** 外部 AI に出してよいブログの発見に出てくる名前の SQL (材料とできあがる味) */
function sendableNamesSql() {
  return Prisma.sql`
    SELECT unnest(d.ingredients) AS name FROM "Discovery" d JOIN "Asset" a ON a.id = d."assetId"
    WHERE ${classificationFilterSql(MAX_EXTERNAL_AI_CLEARANCE, "a")}
    UNION
    SELECT d.result FROM "Discovery" d JOIN "Asset" a ON a.id = d."assetId"
    WHERE d.result IS NOT NULL AND ${classificationFilterSql(MAX_EXTERNAL_AI_CLEARANCE, "a")}`;
}

/** 外部 AI に出してよいブログに出てくる名前の集合 (確認ページで「機密のため作らない」を出すのに使う) */
export async function loadSendableFoodNames(db: PrismaClient = prismaInternal): Promise<Set<string>> {
  const rows = await db.$queryRaw<{ name: string }[]>(sendableNamesSql());
  return new Set(rows.map((r) => r.name));
}

/** アイコンがまだで、cron が試してよい名前 (五十音順) */
export async function loadFoodsNeedingIcons(db: PrismaClient, limit?: number): Promise<FoodIconTarget[]> {
  return db.$queryRaw<FoodIconTarget[]>`
    SELECT f.name, f.category::text AS category, f."iconKey", f."iconNote"
    FROM "DiscoveryFood" f
    WHERE f."iconKey" = '' AND f."iconFailures" < ${FOOD_ICON_MAX_FAILURES}
      AND f.name IN (${sendableNamesSql()})
    ORDER BY f.name
    ${limit ? Prisma.sql`LIMIT ${limit}` : Prisma.empty}`;
}

/** cron があきらめた名前の数 (/status に出す)。もう作れない (機密になった・使われなくなった) 名前は数えない */
export async function countGivenUpFoodIcons(db: PrismaClient): Promise<number> {
  const [{ n }] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "DiscoveryFood" f
    WHERE f."iconKey" = '' AND f."iconFailures" >= ${FOOD_ICON_MAX_FAILURES}
      AND f.name IN (${sendableNamesSql()})`;
  return n;
}

/**
 * 1 つの名前に作って保存する。戻り値は保存した key、保存しなかったら null。
 * **読んだときと key が変わっていたら保存しない** (cron と人の作り直しが同時に走ったとき、人の指示で作ったものを
 * cron の指示なしの絵で上書きしない。名前を変えられて行が消えたときも同じ)。保存しなかった自分の画像は R2 から消す
 */
async function generateAndSave(
  db: PrismaClient,
  food: FoodIconTarget,
  style?: SketchSourceImage,
): Promise<string | null> {
  const icon = await generateFoodIcon({
    name: food.name,
    categoryLabel: FOOD_CATEGORY_LABELS[food.category] ?? null,
    note: food.iconNote,
    style,
  });
  const { count } = await db.discoveryFood.updateMany({
    where: { name: food.name, iconKey: food.iconKey },
    data: { iconKey: icon.key, iconFailures: 0, iconUpdatedAt: new Date() },
  });
  if (count === 0) {
    await deleteFromR2(icon.key).catch(() => {});
    return null;
  }
  return icon.key;
}

export interface AutoIconResult {
  attempted: number;
  generated: number;
  failed: { name: string; message: string }[];
  givenUp: number;
}

/** アイコンの無い名前に作る (cron と CLI)。並べて作り、失敗した名前は回数を数える */
export async function autoGenerateFoodIcons(
  db: PrismaClient = prismaInternal,
  limit = FOOD_ICON_BATCH_SIZE,
): Promise<AutoIconResult> {
  const targets = await loadFoodsNeedingIcons(db, limit);
  if (targets.length === 0) return { attempted: 0, generated: 0, failed: [], givenUp: await countGivenUpFoodIcons(db) };
  // 基準画像は 1 回だけ読む (並べて作る枚数ぶん R2 から取らない)
  const style = await loadFoodIconStyle();
  const results = await Promise.allSettled(targets.map((t) => generateAndSave(db, t, style)));
  const failed: AutoIconResult["failed"] = [];
  let generated = 0;
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") {
      if (r.value) generated++;
      continue;
    }
    failed.push({ name: targets[i].name, message: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  }
  if (failed.length > 0) {
    // 行が消えていても (名前を変えられた) 落ちないよう updateMany
    await db.discoveryFood.updateMany({
      where: { name: { in: failed.map((f) => f.name) } },
      data: { iconFailures: { increment: 1 } },
    });
  }
  return { attempted: targets.length, generated, failed, givenUp: await countGivenUpFoodIcons(db) };
}

/**
 * 確認ページから作り直す。`note` は直す指示 (空なら指示を外す)。次からの作り直しでも使い続ける。
 * 見ている人に見えない名前・外部 AI に出してよいブログに出てこない名前は作らない
 */
export async function regenerateFoodIcon(clearance: string, name: string, note: string): Promise<string> {
  // 見えない名前かどうかを、エラーの違いで知られないよう最初に確かめる
  const visible = await withClearance(clearance, (tx) =>
    tx.discovery.count({ where: { OR: [{ ingredients: { has: name } }, { result: name }] } }),
  );
  if (visible === 0) throw new Error("この名前を使う発見がありません");
  const db = prismaInternal;
  const food = await db.discoveryFood.findUnique({
    where: { name },
    select: { name: true, category: true, iconKey: true },
  });
  if (!food) throw new Error("分類がまだの名前にはアイコンを作れません (先に分類を選んでください)");
  const [{ sendable }] = await db.$queryRaw<{ sendable: boolean }[]>`
    SELECT ${name} IN (${sendableNamesSql()}) AS sendable`;
  if (!sendable) throw new Error("機密のブログにしか出てこない名前なので、外部の AI には送れません");
  await db.discoveryFood.update({ where: { name }, data: { iconNote: note.trim() } });
  const key = await generateAndSave(db, { ...food, iconNote: note.trim() });
  if (!key) throw new Error("作っている間に、ほかの作り直しか名前の変更が先に保存されました。画面を読み込み直してください");
  return key;
}
