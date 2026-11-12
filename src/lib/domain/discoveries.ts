/**
 * 今日の発見 (#432) の DB 側。
 *
 * - 下書き: 今日の発見タグ付きで、bot の見出し (annotation) があり、まだ `Discovery` の行が無いブログを
 *   Claude に渡し、発見ごとの行を作る。**行のあるブログは触らない** (人が直した行を上書きしない)。
 *   入口は CLI (`pnpm cli:draft-discoveries`。過去分・cron があきらめた分) と 15 分 cron (`/api/cron/discoveries`。
 *   登録から 30 日以内・試した回数が上限未満)。どちらも RLS をバイパスする接続を使う
 * - 読み出し: `listDiscoveries` が通し番号付きで返す (REST `GET /api/v1/discoveries`)
 *
 * 純粋な部分 (プロンプト・後処理・番号) は `src/lib/discoveries/core.ts`。
 */

import type { PrismaClient } from "@prisma/client";
import { classificationFilter, classificationFilterSql } from "@/lib/classification";
import { recordUsage } from "@/lib/costs/usage";
import { prisma, prismaInternal, withClearance } from "@/lib/db";
import { MAX_EXTERNAL_AI_CLEARANCE } from "@/lib/meetgreet/config";
import { toJstDateOnly } from "@/lib/utils";
import {
  finalizeCategories,
  finalizeDrafts,
  foodNamesOf,
  numberDiscoveries,
  type DiscoveryConfidenceValue,
  type DiscoveryDraft,
  type DraftSource,
  type FoodCategoryValue,
} from "@/lib/discoveries/core";
import {
  DISCOVERY_AI_FEATURE,
  DiscoveryAiError,
  FOOD_BATCH_SIZE,
  categorizeFoodsWithClaude,
  draftDiscoveriesWithClaude,
  type CallUsage,
  type ClaudeCallOptions,
} from "@/lib/discoveries/llm";

/** 今日の発見タグの canonicalName */
export const DISCOVERY_TAG_NAME = "今日の発見";

/** cron が見る期間。これより前に登録されたブログは CLI で片付ける */
export const AUTO_DRAFT_WINDOW_DAYS = 30;
/** cron が 1 本のブログを試す回数の上限。超えたら cron の対象から外す (CLI では流せる) */
export const AUTO_DRAFT_MAX_ATTEMPTS = 3;
/** cron が 1 回に下書きするブログの本数。新しい回は週に数本なので少なくてよい。時間内に収めるため小さくする */
export const AUTO_DRAFT_BATCH_SIZE = 5;
/** cron の Claude 呼び出し 1 回の時間の上限。下書きと分類で 2 回、各リトライ 1 回でも `maxDuration` (300s) に収める */
export const AUTO_DRAFT_TIMEOUT_MS = 70_000;

interface DraftTargetOptions {
  /** これ以降に登録されたブログだけ (cron) */
  createdAfter?: Date;
  /** 試した回数がこれ未満のブログだけ (cron) */
  maxAttempts?: number;
}

/** 下書きの対象: 今日の発見タグ付きの text アセットで、外部 AI に出してよい機密レベルのもの */
function draftTargetWhere(opts: DraftTargetOptions) {
  return {
    ...(opts.createdAfter ? { createdAt: { gte: opts.createdAfter } } : {}),
    ...(opts.maxAttempts !== undefined
      ? { OR: [{ discoveryDraftAttempt: null }, { discoveryDraftAttempt: { attempts: { lt: opts.maxAttempts } } }] }
      : {}),
    kind: "text" as const,
    ...classificationFilter(MAX_EXTERNAL_AI_CLEARANCE),
    entities: { some: { entity: { type: "tag" as const, canonicalName: DISCOVERY_TAG_NAME } } },
    texts: { some: { textType: "annotation" as const } },
    discoveries: { none: {} },
  };
}

/** 下書きがまだのブログ (古い順)。`db` は RLS をバイパスする接続 */
export async function loadDraftSources(
  db: PrismaClient,
  opts: DraftTargetOptions & { limit?: number } = {},
): Promise<DraftSource[]> {
  const assets = await db.asset.findMany({
    where: draftTargetWhere(opts),
    orderBy: [{ canonicalDate: "asc" }, { createdAt: "asc" }],
    take: opts.limit,
    select: {
      id: true,
      texts: { where: { textType: { in: ["annotation", "extracted"] } }, select: { textType: true, content: true } },
    },
  });
  return assets.map((a) => ({
    assetId: a.id,
    heading: a.texts.find((t) => t.textType === "annotation")?.content.trim() ?? "",
    excerpt: a.texts.find((t) => t.textType === "extracted")?.content.trim() ?? "",
  }));
}

/**
 * いま使われている材料名 (多い順)。LLM に渡して名前を揃えさせる。
 * **外部 AI に出してよい機密レベルのブログの行だけ** (後から上の機密に上げられたブログの材料名を送らない)
 */
export async function loadIngredientVocabulary(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRaw<{ name: string }[]>`
    SELECT name FROM (
      SELECT unnest(d.ingredients) AS name FROM "Discovery" d JOIN "Asset" a ON a.id = d."assetId"
      WHERE ${classificationFilterSql(MAX_EXTERNAL_AI_CLEARANCE, "a")}
    ) t
    GROUP BY name ORDER BY COUNT(*) DESC, name`;
  return rows.map((r) => r.name);
}

export interface DraftBatchResult {
  drafts: Map<string, DiscoveryDraft[]>;
  warnings: { assetId: string; message: string }[];
  model: string;
}

async function reportUsage(model: string, usage: CallUsage) {
  await recordUsage({
    provider: "anthropic",
    model,
    feature: DISCOVERY_AI_FEATURE,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    requests: 1,
  }).catch((e) => console.warn(`[discoveries] 利用量の記録に失敗: ${e instanceof Error ? e.message : e}`));
}

/** ブログ何本かを Claude に下書きさせる (保存はしない)。利用量は `/costs` に申告する */
export async function draftBatch(
  sources: DraftSource[],
  vocabulary: string[],
  opts: ClaudeCallOptions = {},
): Promise<DraftBatchResult> {
  const call = await draftDiscoveriesWithClaude(sources, vocabulary, opts);
  await reportUsage(call.model, call.usage);
  const { drafts, warnings } = finalizeDrafts(sources, call.response);
  return { drafts, warnings, model: call.model };
}

/**
 * 分類がまだ無い食べ物の名前。`Discovery` の行 (外部 AI に出してよい機密レベルのブログのもの) に出てくる名前と、
 * `extra` (保存前の下書きに出てくる名前) のうち、`DiscoveryFood` に無いもの。`db` は RLS をバイパスする接続
 */
export async function loadUncategorizedFoods(db: PrismaClient, extra: string[] = []): Promise<string[]> {
  const rows = await db.$queryRaw<{ name: string }[]>`
    SELECT DISTINCT name FROM (
      SELECT unnest(d.ingredients) AS name FROM "Discovery" d JOIN "Asset" a ON a.id = d."assetId"
      WHERE ${classificationFilterSql(MAX_EXTERNAL_AI_CLEARANCE, "a")}
      UNION
      SELECT d.result FROM "Discovery" d JOIN "Asset" a ON a.id = d."assetId"
      WHERE d.result IS NOT NULL AND ${classificationFilterSql(MAX_EXTERNAL_AI_CLEARANCE, "a")}
    ) t`;
  return withoutCategory(db, [...rows.map((r) => r.name), ...extra]);
}

/** `names` のうち `DiscoveryFood` に無いもの (重複を除いて五十音順) */
async function withoutCategory(db: PrismaClient, names: string[]): Promise<string[]> {
  const set = new Set(names);
  if (set.size === 0) return [];
  const known = await db.discoveryFood.findMany({ where: { name: { in: [...set] } }, select: { name: true } });
  for (const k of known) set.delete(k.name);
  return [...set].sort((a, b) => a.localeCompare(b, "ja"));
}

/** 名前の分類を Claude に下書きさせる (保存はしない)。返ってこなかった名前は入らない */
export async function categorizeBatch(
  names: string[],
  opts: ClaudeCallOptions = {},
): Promise<Map<string, FoodCategoryValue>> {
  if (names.length === 0) return new Map();
  const call = await categorizeFoodsWithClaude(names, opts);
  await reportUsage(call.model, call.usage);
  return finalizeCategories(names, call.response);
}

/** 分類を保存する。**既にある名前は上書きしない** (人が直した分類を残す)。戻り値は書いた行数 */
export async function saveFoodCategories(db: PrismaClient, categories: Map<string, FoodCategoryValue>): Promise<number> {
  if (categories.size === 0) return 0;
  const { count } = await db.discoveryFood.createMany({
    data: [...categories].map(([name, category]) => ({ name, category })),
    skipDuplicates: true,
  });
  return count;
}

/**
 * 下書きを保存する。**そのブログに行が 1 つでもあれば何もしない** (人が直した行・先に走った処理の行を残す)。
 * cron と CLI が同時に走っても 1 本のブログに 2 回分の行が混ざらないよう、ブログごとの advisory lock を取ってから確かめる。
 * 戻り値は書いた行数。`db` は RLS をバイパスする接続
 */
export async function saveDrafts(
  db: PrismaClient,
  assetId: string,
  drafts: DiscoveryDraft[],
  draftModel: string | null,
): Promise<number> {
  if (drafts.length === 0) return 0;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`discovery:${assetId}`}))`;
    const existing = await tx.discovery.count({ where: { assetId } });
    if (existing > 0) return 0;
    const { count } = await tx.discovery.createMany({
      data: drafts.map((d) => ({ assetId, ...d, draftModel })),
    });
    return count;
  });
}

export interface AutoDraftResult {
  /** 下書きを頼んだブログ */
  attempted: number;
  /** 行を保存したブログ */
  drafted: number;
  /** 保存した発見の行 */
  rows: number;
  /** 保存した分類 */
  foods: number;
  /** 試した回数が上限に達して cron の対象から外れたブログ (期間内のもの。CLI で流す) */
  givenUp: number;
  warnings: { assetId: string; message: string }[];
}

/**
 * 15 分 cron の本体。最近登録された、行の無いブログを 1 回ぶん (最大 `AUTO_DRAFT_BATCH_SIZE` 本) 下書きして保存し、
 * **その回に保存した行に出てくる名前だけ**分類する。
 *
 * - Claude を呼ぶ前に、対象のブログの試した回数を 1 増やす (途中で関数が打ち切られても数える)。
 *   `AUTO_DRAFT_MAX_ATTEMPTS` 回試しても行ができないブログは対象から外れる (同じブログに Claude を呼び続けない)
 * - 分類を返してこなかった名前は追いかけない (毎回頼み直さない)。CLI を流すと拾う
 * - `DiscoveryAiError` は失敗の理由を記録してから投げ直す (呼び出し側がハートビートに失敗として残す)
 */
export async function autoDraftDiscoveries(now: Date = new Date()): Promise<AutoDraftResult> {
  const db = prismaInternal;
  const createdAfter = new Date(now.getTime() - AUTO_DRAFT_WINDOW_DAYS * 86_400_000);
  const sources = await loadDraftSources(db, {
    limit: AUTO_DRAFT_BATCH_SIZE,
    createdAfter,
    maxAttempts: AUTO_DRAFT_MAX_ATTEMPTS,
  });
  const result: AutoDraftResult = { attempted: sources.length, drafted: 0, rows: 0, foods: 0, givenUp: 0, warnings: [] };

  if (sources.length > 0) {
    const ids = sources.map((s) => s.assetId);
    await recordAttempts(db, ids, now, null);
    let batch: DraftBatchResult;
    try {
      batch = await draftBatch(sources, await loadIngredientVocabulary(db), { timeoutMs: AUTO_DRAFT_TIMEOUT_MS });
    } catch (e) {
      const reason = e instanceof DiscoveryAiError ? e.message : "下書きに失敗しました";
      await db.discoveryDraftAttempt.updateMany({ where: { assetId: { in: ids } }, data: { lastError: reason } });
      throw e;
    }
    result.warnings = batch.warnings;
    const saved: DiscoveryDraft[] = [];
    for (const [assetId, drafts] of batch.drafts) {
      const n = await saveDrafts(db, assetId, drafts, batch.model);
      if (n > 0) {
        result.drafted++;
        result.rows += n;
        saved.push(...drafts);
      }
    }
    const missed = ids.filter((id) => !batch.drafts.has(id));
    if (missed.length > 0) {
      await db.discoveryDraftAttempt.updateMany({
        where: { assetId: { in: missed } },
        data: { lastError: "下書きが返ってきませんでした" },
      });
    }

    const names = await withoutCategory(db, foodNamesOf(saved));
    if (names.length > 0) {
      result.foods = await saveFoodCategories(
        db,
        await categorizeBatch(names.slice(0, FOOD_BATCH_SIZE), { timeoutMs: AUTO_DRAFT_TIMEOUT_MS }),
      );
    }
  }

  result.givenUp = await db.asset.count({
    where: {
      ...draftTargetWhere({ createdAfter }),
      discoveryDraftAttempt: { attempts: { gte: AUTO_DRAFT_MAX_ATTEMPTS } },
    },
  });
  return result;
}

/** 試した回数を 1 増やす (行が無ければ作る)。`lastError` は今回の結果で上書きする */
async function recordAttempts(db: PrismaClient, assetIds: string[], now: Date, lastError: string | null) {
  await db.$transaction(
    assetIds.map((assetId) =>
      db.discoveryDraftAttempt.upsert({
        where: { assetId },
        create: { assetId, attempts: 1, lastError, lastTriedAt: now },
        update: { attempts: { increment: 1 }, lastError, lastTriedAt: now },
      }),
    ),
  );
}

export interface DiscoveryView {
  /** 通し番号 (1 始まり)。見える範囲の全件で振る */
  no: number;
  id: string;
  assetId: string;
  position: number;
  heading: string;
  excerpt: string;
  isFood: boolean;
  ingredients: string[];
  result: string | null;
  confidence: DiscoveryConfidenceValue;
  /** 人が確かめたか */
  reviewed: boolean;
  /** ブログの日付 (JST, YYYY-MM-DD) */
  date: string;
  blogTitle: string;
  /** 公式ブログの URL (無ければ null) */
  url: string | null;
}

/** 食べ物の名前 → 分類とアイコンの R2 key (#436)。アイコンがまだの名前は iconKey が空文字 */
export async function listFoodRows(): Promise<{ name: string; category: FoodCategoryValue; iconKey: string }[]> {
  return prisma.discoveryFood.findMany({ select: { name: true, category: true, iconKey: true } });
}

/** 通し番号付きの全件 (古い順)。RLS 越しに読む */
export async function listDiscoveries(clearance: string): Promise<DiscoveryView[]> {
  const rows = await withClearance(clearance, (tx) =>
    tx.discovery.findMany({
      select: {
        id: true,
        assetId: true,
        position: true,
        heading: true,
        excerpt: true,
        isFood: true,
        ingredients: true,
        result: true,
        confidence: true,
        reviewedAt: true,
        asset: {
          select: {
            title: true,
            canonicalDate: true,
            createdAt: true,
            sourceRecords: {
              where: { url: { contains: "detail/" } },
              select: { url: true },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    }),
  );
  return numberDiscoveries(
    rows.map((r) => ({
      id: r.id,
      assetId: r.assetId,
      position: r.position,
      heading: r.heading,
      excerpt: r.excerpt,
      isFood: r.isFood,
      ingredients: r.ingredients,
      result: r.result,
      confidence: r.confidence,
      reviewed: r.reviewedAt !== null,
      date: toJstDateOnly(r.asset.canonicalDate ?? r.asset.createdAt)!,
      blogTitle: r.asset.title,
      url: r.asset.sourceRecords[0]?.url ?? null,
    })),
  );
}
