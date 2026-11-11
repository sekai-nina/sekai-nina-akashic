/**
 * 今日の発見の下書きを Claude に作らせ、発見ごとの行 (`Discovery`) を作る (#432)。
 *
 * 対象は、今日の発見タグ付きで bot の見出し (annotation) があり、まだ行が無いブログ。
 * **行のあるブログは触らない** ので、何度流してもよい (人が直した行は残る)。
 * 古い順に 20 本ずつ頼み、前の回で出た材料名を次の回に渡して名前を揃えさせる。
 * そのあと、材料・できあがる味の名前のうち分類 (`DiscoveryFood`) がまだのものを分類させる (既にある分類は上書きしない)。
 *
 * 下見でも Claude は呼ぶ (費用がかかる。100 本で $0.5 程度)。下見の結果を --out に書き出しておけば、
 * --apply --from でその結果をそのまま保存できる (もう一度 Claude を呼ばない)。
 *
 * 書き込みは DIRECT_URL (RLS バイパス)。既定は下見、--apply で書く。
 *
 * Usage:
 *   pnpm cli:draft-discoveries [--limit N] [--out drafts.json]   # 下見 (Claude を呼ぶ・DB は書かない)
 *   pnpm cli:draft-discoveries --from drafts.json --out d2.json   # 下見の結果を読み、分類がまだの名前だけ分類させる
 *   pnpm cli:draft-discoveries --apply --from drafts.json         # 下見の結果を保存 (分類が足りなければ分類させる)
 *   pnpm cli:draft-discoveries --apply [--limit N]                # 下書きして保存
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { FOOD_CATEGORIES, foodNamesOf, type DiscoveryDraft, type FoodCategoryValue } from "@/lib/discoveries/core";
import {
  DISCOVERY_AI_MODEL,
  DISCOVERY_BATCH_SIZE,
  DiscoveryAiError,
  FOOD_BATCH_SIZE,
  isDiscoveryAiConfigured,
} from "@/lib/discoveries/llm";
import {
  categorizeBatch,
  draftBatch,
  loadDraftSources,
  loadIngredientVocabulary,
  loadUncategorizedFoods,
  saveDrafts,
  saveFoodCategories,
} from "@/lib/domain/discoveries";
import { FOOD_CATEGORY_LABELS } from "@/lib/utils";

if (!process.env.DIRECT_URL) {
  console.error("DIRECT_URL が未設定です (このスクリプトは RLS バイパス接続が必須)");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
function argValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const LIMIT = argValue("--limit") ? Number(argValue("--limit")) : undefined;
if (LIMIT !== undefined && !(Number.isInteger(LIMIT) && LIMIT > 0)) {
  console.error("--limit には 1 以上の整数を渡してください");
  process.exit(1);
}
const OUT = argValue("--out");
const FROM = argValue("--from");

interface SavedDrafts {
  model: string;
  blogs: { assetId: string; heading: string; drafts: DiscoveryDraft[] }[];
  /** 食べ物の名前 → 分類 (分類がまだだった名前のぶんだけ) */
  foods?: Record<string, FoodCategoryValue>;
}

/** 下書き (と DB の行) に出てくる名前のうち、分類がまだのものを分類させて saved.foods に足す */
async function categorizeMissing(saved: SavedDrafts) {
  const foods = { ...(saved.foods ?? {}) };
  const extra = foodNamesOf(saved.blogs.flatMap((b) => b.drafts));
  const missing = (await loadUncategorizedFoods(prisma, extra)).filter((n) => !(n in foods));
  if (missing.length === 0) {
    saved.foods = foods;
    return;
  }
  if (!isDiscoveryAiConfigured()) throw new Error("ANTHROPIC_API_KEY が未設定です");
  console.log(`\n--- 分類がまだの名前 ${missing.length} 個を分類中`);
  for (let i = 0; i < missing.length; i += FOOD_BATCH_SIZE) {
    const chunk = missing.slice(i, i + FOOD_BATCH_SIZE);
    try {
      for (const [name, category] of await categorizeBatch(chunk)) foods[name] = category;
    } catch (e) {
      if (!(e instanceof DiscoveryAiError)) throw e;
      console.error(`分類に失敗: ${e.message}`);
      if (e.stopBatch) break;
    }
  }
  const left = missing.filter((n) => !(n in foods));
  if (left.length > 0) console.log(`分類が返ってこなかった名前 (次の回に回す): ${left.join("、")}`);
  saved.foods = foods;
}

function printFoods(foods: Record<string, FoodCategoryValue>) {
  const byCategory = new Map<FoodCategoryValue, string[]>();
  for (const [name, c] of Object.entries(foods)) byCategory.set(c, [...(byCategory.get(c) ?? []), name]);
  console.log("\n分類:");
  for (const c of FOOD_CATEGORIES) {
    const names = byCategory.get(c);
    if (names) console.log(`  ${FOOD_CATEGORY_LABELS[c]} (${names.length}): ${names.join("、")}`);
  }
}

function printBlog(heading: string, drafts: DiscoveryDraft[]) {
  console.log(`\n■ ${heading}`);
  for (const d of drafts) {
    const eq = d.isFood ? `${d.ingredients.join(" ＋ ")}${d.result ? ` → ${d.result}` : ""}` : "(食べ物以外)";
    console.log(`  ${d.position + 1}. ${d.heading}\n     ${eq}  [${d.confidence}]`);
  }
}

async function saveAll(saved: SavedDrafts) {
  let rows = 0;
  let skipped = 0;
  for (const b of saved.blogs) {
    const n = await saveDrafts(prisma, b.assetId, b.drafts, saved.model);
    if (n === 0) skipped++;
    rows += n;
  }
  console.log(`\n保存: ${rows} 行 (行が既にあって飛ばしたブログ ${skipped} 本)`);
  const foods = new Map(Object.entries(saved.foods ?? {}));
  const n = await saveFoodCategories(prisma, foods);
  console.log(`分類の保存: ${n} 個 (既にあって飛ばした名前 ${foods.size - n} 個)`);
}

async function main() {
  if (FROM) {
    const saved = JSON.parse(readFileSync(FROM, "utf-8")) as SavedDrafts;
    for (const b of saved.blogs) printBlog(b.heading, b.drafts);
    await categorizeMissing(saved);
    printFoods(saved.foods ?? {});
    if (OUT) {
      writeFileSync(OUT, JSON.stringify(saved, null, 2));
      console.log(`\n書き出しました: ${OUT}`);
    }
    if (APPLY) await saveAll(saved);
    return;
  }
  if (!isDiscoveryAiConfigured()) throw new Error("ANTHROPIC_API_KEY が未設定です");

  const sources = await loadDraftSources(prisma, { limit: LIMIT });
  console.log(`今日の発見の下書き (${APPLY ? "書き込み" : "下見。書くには --apply"}): 対象 ${sources.length} 本`);
  if (sources.length === 0) return;

  const vocabulary = new Set(await loadIngredientVocabulary(prisma));
  const saved: SavedDrafts = { model: DISCOVERY_AI_MODEL, blogs: [] };
  const warnings: { assetId: string; message: string }[] = [];
  for (let i = 0; i < sources.length; i += DISCOVERY_BATCH_SIZE) {
    const chunk = sources.slice(i, i + DISCOVERY_BATCH_SIZE);
    console.log(`\n--- ${i + 1}〜${i + chunk.length} 本目を下書き中`);
    let result;
    try {
      result = await draftBatch(chunk, [...vocabulary]);
    } catch (e) {
      if (e instanceof DiscoveryAiError) {
        console.error(`下書きに失敗: ${e.message}`);
        if (e.stopBatch) break;
        continue;
      }
      throw e;
    }
    saved.model = result.model;
    warnings.push(...result.warnings);
    for (const source of chunk) {
      const drafts = result.drafts.get(source.assetId);
      if (!drafts) continue;
      saved.blogs.push({ assetId: source.assetId, heading: source.heading, drafts });
      for (const d of drafts) for (const name of d.ingredients) vocabulary.add(name);
      printBlog(source.heading, drafts);
    }
  }

  const total = saved.blogs.reduce((n, b) => n + b.drafts.length, 0);
  console.log(`\n下書き: ブログ ${saved.blogs.length} 本 → 発見 ${total} 件 / 材料名 ${vocabulary.size} 種`);
  if (warnings.length > 0) {
    console.log(`\n確認してほしい点 (${warnings.length} 件):`);
    for (const w of warnings) console.log(`  - ${w.assetId}: ${w.message}`);
  }
  await categorizeMissing(saved);
  printFoods(saved.foods ?? {});
  if (OUT) {
    writeFileSync(OUT, JSON.stringify(saved, null, 2));
    console.log(`\n下書きを書き出しました: ${OUT} (保存するには --apply --from ${OUT})`);
  }
  if (APPLY) await saveAll(saved);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
