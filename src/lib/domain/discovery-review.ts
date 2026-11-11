/**
 * 今日の発見の確認ページ (`/discoveries`, #432 PR2) の DB 側。
 *
 * - 確認待ち: 人が確かめていない発見 (`reviewedAt` が null) のあるブログを、通し番号の順に 1 本ずつ出す
 * - ブログ単位で保存: そのブログの発見を丸ごと置き換え、すべてに `reviewedAt` を立てる (cron はもう触らない)
 * - 材料と分類: 名前の一覧 (回数・分類)。分類の変更と、名前の変更 (全部の発見で書き換え・統合)
 * - cron があきらめたブログ (`DiscoveryDraftAttempt.attempts` が上限以上で行が無い) を出し、やり直させる
 *
 * 保護テーブル (`Discovery` / `DiscoveryDraftAttempt` / `Asset`) は `withClearance` を通す。
 * `DiscoveryFood` は非保護だが、名前の変更は発見の書き換えと 1 トランザクションにしたいので同じ tx で触る
 * (app_runtime に素通しのポリシーがある)。
 */

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { withClearance, prisma, prismaInternal } from "@/lib/db";
import { DISCOVERY_CONFIDENCES, FOOD_CATEGORIES, type FoodCategoryValue } from "@/lib/discoveries/core";
import { AUTO_DRAFT_MAX_ATTEMPTS, DISCOVERY_TAG_NAME, type DiscoveryView } from "./discoveries";
import { toJstDateOnly } from "@/lib/utils";

/** 確認ページで直す発見 1 件 (ブログの中の順に並べる。position は保存時に振り直す) */
export const DiscoveryInputSchema = z.object({
  heading: z.string().trim().min(1, "見出しが空です").max(200),
  excerpt: z.string().trim().min(1, "本文の抜粋が空です").max(5000),
  isFood: z.boolean(),
  ingredients: z.array(z.string().trim().min(1).max(50).transform((s) => s.normalize("NFKC"))).max(20),
  result: z.string().trim().max(50).transform((s) => s.normalize("NFKC")).nullable(),
  confidence: z.enum(DISCOVERY_CONFIDENCES),
});
export type DiscoveryInput = z.infer<typeof DiscoveryInputSchema>;
export const SaveBlogSchema = z.array(DiscoveryInputSchema).min(1, "発見が 1 件もありません").max(10);

export const FoodNameSchema = z.string().trim().min(1, "名前が空です").max(50).transform((s) => s.normalize("NFKC"));
export const FoodCategorySchema = z.enum(FOOD_CATEGORIES);

export interface ReviewBlog {
  assetId: string;
  title: string;
  date: string;
  url: string | null;
  /** bot が抜き出した本文 (extracted)。無ければ空 */
  excerpt: string;
  discoveries: (DiscoveryInput & { no: number; reviewed: boolean })[];
}

/** 今日の発見のブログか (今日の発見タグ付きの text アセット)。下書きの対象 (`draftTargetWhere`) と同じ条件 */
const discoveryBlogWhere = {
  kind: "text" as const,
  entities: { some: { entity: { type: "tag" as const, canonicalName: DISCOVERY_TAG_NAME } } },
};

/** 1 本のブログと、その発見 (ブログ内の順)。`all` は `listDiscoveries` の結果 (ページで読んだものを使い回す)。見えなければ null */
export async function getReviewBlog(clearance: string, assetId: string, all: DiscoveryView[]): Promise<ReviewBlog | null> {
  const asset = await withClearance(clearance, (tx) =>
      tx.asset.findFirst({
        where: { id: assetId, ...discoveryBlogWhere },
        select: {
          id: true,
          title: true,
          canonicalDate: true,
          createdAt: true,
          texts: { where: { textType: "extracted" }, select: { content: true }, take: 1 },
          sourceRecords: {
            where: { url: { contains: "detail/" } },
            select: { url: true },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
        },
      }),
  );
  if (!asset) return null;
  const rows = all.filter((d) => d.assetId === assetId).sort((a, b) => a.position - b.position);
  return {
    assetId,
    title: asset.title,
    date: toJstDateOnly(asset.canonicalDate ?? asset.createdAt)!,
    url: asset.sourceRecords[0]?.url ?? null,
    excerpt: asset.texts[0]?.content ?? "",
    discoveries: rows.map(toInput),
  };
}

function toInput(d: DiscoveryView): DiscoveryInput & { no: number; reviewed: boolean } {
  return {
    no: d.no,
    reviewed: d.reviewed,
    heading: d.heading,
    excerpt: d.excerpt,
    isFood: d.isFood,
    ingredients: d.ingredients,
    result: d.result,
    confidence: d.confidence,
  };
}

/** 確認待ちのブログ (通し番号の順。重複なし) と、その数 */
export function reviewQueue(all: DiscoveryView[]): string[] {
  const ids: string[] = [];
  for (const d of all) if (!d.reviewed && !ids.includes(d.assetId)) ids.push(d.assetId);
  return ids;
}

/**
 * ブログの発見を丸ごと置き換えて確定する。並びは渡した順 (position を 0 から振り直す)。
 * 1 トランザクション。行は親アセットの RLS で守られる (見えないブログには書けない)
 */
export async function saveReviewedBlog(clearance: string, assetId: string, items: DiscoveryInput[], now = new Date()) {
  await withClearance(clearance, async (tx) => {
    // 下書きの保存 (`saveDrafts`) と同じロック。cron・CLI・別の人の保存と混ざらないようにする
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`discovery:${assetId}`}))`;
    const asset = await tx.asset.findFirst({ where: { id: assetId, ...discoveryBlogWhere }, select: { id: true } });
    if (!asset) throw new Error("今日の発見のブログが見つかりません");
    // 下書きしたモデルは残す (人が確かめたかは reviewedAt で分かる)。id と createdAt は作り直しで変わる
    const before = await tx.discovery.findFirst({ where: { assetId }, select: { draftModel: true } });
    await tx.discovery.deleteMany({ where: { assetId } });
    await tx.discovery.createMany({
      data: items.map((d, position) => ({
        assetId,
        position,
        heading: d.heading,
        excerpt: d.excerpt,
        isFood: d.isFood,
        ingredients: d.isFood ? [...new Set(d.ingredients)] : [],
        result: d.isFood && d.result ? d.result : null,
        confidence: d.confidence,
        draftModel: before?.draftModel ?? null,
        reviewedAt: now,
      })),
    });
  });
}

export interface FoodRow {
  name: string;
  /** 材料として使われた回数 */
  asIngredient: number;
  /** できあがる味として使われた回数 */
  asResult: number;
  /** 分類。まだなら null */
  category: FoodCategoryValue | null;
}

/** 見える発見 (`all`) に出てくる名前の一覧 (分類がまだのもの → 回数の多い順) */
export async function listFoods(all: DiscoveryView[]): Promise<FoodRow[]> {
  const foods = await prisma.discoveryFood.findMany({ select: { name: true, category: true } });
  const category = new Map(foods.map((f) => [f.name, f.category as FoodCategoryValue]));
  const rows = new Map<string, FoodRow>();
  const row = (name: string) => {
    let r = rows.get(name);
    if (!r) rows.set(name, (r = { name, asIngredient: 0, asResult: 0, category: category.get(name) ?? null }));
    return r;
  };
  for (const d of all) {
    for (const i of d.ingredients) row(i).asIngredient++;
    if (d.result) row(d.result).asResult++;
  }
  return [...rows.values()].sort(
    (a, b) =>
      Number(a.category !== null) - Number(b.category !== null) ||
      b.asIngredient + b.asResult - (a.asIngredient + a.asResult) ||
      a.name.localeCompare(b.name, "ja"),
  );
}

/** 分類を置く (無ければ作る)。非保護テーブル */
export async function setFoodCategory(name: string, category: FoodCategoryValue) {
  await prisma.discoveryFood.upsert({ where: { name }, create: { name, category }, update: { category } });
}

/**
 * 名前を変える。その名前を使う発見 (見える範囲) の材料・できあがる味をすべて書き換える。
 * 変更先が既にある名前なら統合する (材料の重複は除き、並びは元のまま。分類は変更先のものを残す)。
 * 元の名前の分類は、**見えないブログも含めて**もう誰も使っていないときだけ消す
 * (機密の高いブログが同じ名前を使っていると、その分類が消えて二度と付かなくなるため)。戻り値は書き換えた発見の数
 */
export async function renameFood(clearance: string, from: string, to: string): Promise<number> {
  if (from === to) return 0;
  const changed = await withClearance(clearance, async (tx) => {
    // 1 文で書き換える。重複を除くときは最初に出た位置で並べ直す
    const n = await tx.$executeRaw(Prisma.sql`
      UPDATE "Discovery" SET
        ingredients = ARRAY(
          SELECT x FROM (
            SELECT x, MIN(o) AS o FROM unnest(array_replace(ingredients, ${from}, ${to})) WITH ORDINALITY u(x, o) GROUP BY x
          ) s ORDER BY o
        ),
        result = CASE WHEN result = ${from} THEN ${to} ELSE result END,
        "updatedAt" = now()
      WHERE ${from} = ANY(ingredients) OR result = ${from}`);
    const [src, dst] = await Promise.all([
      tx.discoveryFood.findUnique({ where: { name: from } }),
      tx.discoveryFood.findUnique({ where: { name: to } }),
    ]);
    if (src && !dst) await tx.discoveryFood.create({ data: { name: to, category: src.category } });
    return n;
  });
  // 見えないブログも含めて、まだ元の名前を使っているか (RLS をバイパスして数える。件数だけで中身は返さない)
  const stillUsed = await prismaInternal.discovery.count({
    where: { OR: [{ ingredients: { has: from } }, { result: from }] },
  });
  if (stillUsed === 0) await prisma.discoveryFood.deleteMany({ where: { name: from } });
  return changed;
}

export interface GivenUpBlog {
  assetId: string;
  title: string;
  attempts: number;
  lastError: string | null;
}

/** cron があきらめたブログ (試した回数が上限以上で、発見の行が無い) */
export async function listGivenUpBlogs(clearance: string): Promise<GivenUpBlog[]> {
  const rows = await withClearance(clearance, (tx) =>
    tx.discoveryDraftAttempt.findMany({
      where: {
        attempts: { gte: AUTO_DRAFT_MAX_ATTEMPTS },
        asset: {
          discoveries: { none: {} },
          entities: { some: { entity: { type: "tag", canonicalName: DISCOVERY_TAG_NAME } } },
        },
      },
      select: { assetId: true, attempts: true, lastError: true, asset: { select: { title: true } } },
      orderBy: { lastTriedAt: "desc" },
      take: 50,
    }),
  );
  return rows.map((r) => ({ assetId: r.assetId, title: r.asset.title, attempts: r.attempts, lastError: r.lastError }));
}

/** cron にもう一度試させる (試した記録を消す) */
export async function retryGivenUpBlog(clearance: string, assetId: string) {
  await withClearance(clearance, (tx) => tx.discoveryDraftAttempt.deleteMany({ where: { assetId } }));
}

/** 「すべて」タブの並び (新しい順) */
export function newestFirst(all: DiscoveryView[]): DiscoveryView[] {
  return [...all].sort((a, b) => b.no - a.no);
}
