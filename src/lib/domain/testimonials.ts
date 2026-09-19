import { prismaInternal, withClearance } from "@/lib/db";
import { TestimonialCategory, TestimonialStatus } from "@prisma/client";
import { searchMentions, MentionResult } from "./mentions";
import { recordUsage } from "@/lib/costs/usage";
import { normalizeTrait, splitTraits } from "./testimonial-traits";

/**
 * 口コミ抽出のモデル。
 *
 * 人が承認/却下した実データ 80 件 (承認 40 / 却下 40) で 2 回ずつ比べて決めた (2026-09-20):
 *
 * | モデル | 承認を拾えた | 却下も拾った | カテゴリ一致 | 無回答 | 80 件の費用 |
 * |---|---|---|---|---|---|
 * | gpt-4o-mini  | 35/40 | 20-22/40 | 30-32/40 | 4 | $0.004 |
 * | gpt-5-nano   | 33/40 | 30/40    | 33/40    | 0 | $0.022 |
 * | gpt-5.6-luna | 38-39/40 | **14/40** | 33-34/40 | 0 | $0.011 |
 * | gpt-5.4-mini | 39-40/40 | 27-32/40 | 35-36/40 | 0 | $0.027 |
 *
 * luna を採った。拾い漏らしが減ったうえに**却下に回る誤検出が 3 割減る** (= 人の確認が軽くなる)。
 * gpt-4o-mini は「スキップするな」と指示しているのに毎回 4 件無回答だった。
 * gpt-5.4-mini は拾う力は一番だが誤検出も多く、値段は 2 倍以上。
 * 単価は gpt-4o-mini より高いが、この機能は月に数回しか動かないので絶対額は誤差。
 */
const OPENAI_MODEL = "gpt-5.6-luna";
const BATCH_SIZE = 15;

interface ExtractionResult {
  is_personality: boolean;
  quote: string;
  trait: string;
  category: string;
  confidence: number;
}

interface ExtractOptions {
  entityId: string;
  limit?: number; // max mentions to process per run
  sinceDate?: Date; // only process mentions after this date
  assetId?: string; // scope to a single asset (avoids full-table scan)
  clearance?: string; // RLS clearance for the full-scan mention search (default "public")
}

const SYSTEM_PROMPT = `あなたは日向坂46のメンバーのブログから、坂井新奈に関する「口コミ」になりうる記述を抽出するアシスタントです。
ここでの口コミとは、本人以外の人物が語った、坂井新奈の人柄・性格・パフォーマンス、および関係性・愛されエピソード（他メンバーから慕われている/可愛がられている様子や、仲の良さが具体的に伝わる描写）を指します。

各テキストブロックについて、以下を判断してください:
1. そのブロックが坂井新奈について、上記の口コミになりうる内容を含むか（含むなら is_personality: true）
2. 単なる名前の列挙・活動報告・予定告知だけ、または「坂井」「新奈」「にいな」「にいたん」等が固有名詞として彼女を指していない偶然の文字列一致（例:「ここにいたんだよ」「渦中にいながら」「絶対にいないと思う」）の場合は is_personality: false

**抽出対象の例:**
- 性格・人柄の描写（優しい、面白い、しっかり者など）
- ダンス・パフォーマンスの特徴、スキル・特技
- 癖や特徴的な行動、外見・雰囲気、好み・嗜好
- 関係性・愛されエピソード（例:「にぃなにめろめろ」「わんちゃんみたいに接している」「ずっと追いかけている」「皆にぃたんを守って」「全部付き合ってくれる」など、他メンバーからの好意や慕われ方が具体的に伝わるもの）

**除外するもの:**
- 「坂井新奈ちゃんです！」のような単なる紹介や、本人による自己紹介
- メンバーリスト・収録曲・セットリスト内の名前の列挙
- 「明日はにぃたんのブログです」のような事務連絡・配信/イベント告知
- 固有名詞ではない偶然の文字列一致（彼女を指していないもの）
- 単なる事実の羅列で、人柄も関係性のニュアンスも読み取れないもの（例:「一緒に行った」だけ）

**category の使い分け:**
- personality: 性格・人柄・外見・好み・癖
- performance: ダンス・歌・パフォーマンス・スキル
- relationship: 他メンバーとの仲の良さ・慕われ方・愛されエピソード

**trait(言われ方)の付け方:**
- 短いキーワード1つ（例: 優しい, 可愛い, しっかり者, 方向音痴）。文にしない。「〜な性格」「〜な存在」のような言い回しにしない
- 後述の「既存のキーワード」と同じ意味なら、必ずその表記をそのまま使う（可愛らしい→可愛い、愛されエピソード→愛されている のような表記ゆれを作らない）
- どれにも当てはまらないときだけ新しいキーワードを付ける

重要:
- 入力の各ブロック [N] に対して、必ず1つの結果をindex=Nとして返してください。スキップしないでください。
- quoteは原文からそのまま抜き出してください。複数箇所を「...」で繋いだり要約したりしないでください。
- 1つのブロックから複数読み取れる場合でも、最も口コミとして印象的な1つだけをquoteとして選んでください。`;

/** プロンプトに載せる既存 trait の上限。承認済みの多い順 */
const TRAIT_VOCABULARY_LIMIT = 40;

/**
 * 承認済み口コミの trait を多い順に集める。抽出プロンプトに渡して表記ゆれを防ぐ。
 * 却下分は語彙に入れない（却下された言い方を LLM に勧めない）
 */
async function loadTraitVocabulary(entityId: string): Promise<string[]> {
  const rows = await prismaInternal.testimonial.findMany({
    where: { entityId, status: "approved" },
    select: { trait: true },
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const t of splitTraits(normalizeTrait(row.trait))) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
    .slice(0, TRAIT_VOCABULARY_LIMIT)
    .map(([t]) => t);
}

const RESPONSE_SCHEMA = {
  name: "testimonial_extraction",
  strict: true,
  schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "number", description: "入力ブロックの [N] の番号" },
            is_personality: { type: "boolean" },
            quote: { type: "string", description: "口コミに該当する部分のみ原文から抜粋。100文字以内" },
            trait: { type: "string", description: "言われ方のキーワード1つ。既存のキーワードと同じ意味ならその表記を使う。例: 優しい, 可愛い, しなやかなダンス" },
            category: { type: "string", enum: ["personality", "performance", "relationship"] },
            confidence: { type: "number", description: "0-1" },
          },
          required: ["index", "is_personality", "quote", "trait", "category", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  },
};

function buildUserPrompt(
  blocks: { index: number; text: string; speaker: string }[],
  vocabulary: string[]
): string {
  const items = blocks.map(
    (b) => `[${b.index}] (by ${b.speaker})\n${b.text}`
  );
  // 語彙は user 側に付ける（system プロンプトは固定のままキャッシュを効かせる）
  const vocab = vocabulary.length
    ? `既存のキーワード（同じ意味ならこの表記を使う）: ${vocabulary.join(", ")}\n\n`
    : "";
  return `${vocab}以下の${blocks.length}個のテキストブロックを分析してください:\n\n${items.join("\n\n---\n\n")}`;
}

function parseSpeakerFromLinkedEntities(linkedEntities: string): string {
  // Extract author from linked entities like "ブログ (), 鶴崎仁香 (author)"
  const authorMatch = linkedEntities.match(/([^,]+?)\s*\(author\)/);
  if (authorMatch) return authorMatch[1].trim();

  // Fallback: first entity name
  const firstEntity = linkedEntities.split(",")[0]?.trim();
  return firstEntity || "不明";
}

function parseSourceUrl(sourceInfo: string): string | null {
  const urlMatch = sourceInfo.match(/url:\s*(https?:\/\/[^\s[\]]+)/);
  return urlMatch ? urlMatch[1] : null;
}

function mapCategory(cat: string): TestimonialCategory {
  const map: Record<string, TestimonialCategory> = {
    personality: "personality",
    performance: "performance",
    relationship: "relationship",
    // Legacy mappings
    appearance: "personality",
    dance: "performance",
    skill: "performance",
    habit: "personality",
    preference: "personality",
    other: "personality",
  };
  return map[cat] || "personality";
}

async function callOpenAI(
  blocks: { index: number; text: string; speaker: string }[],
  vocabulary: string[]
): Promise<(ExtractionResult & { index: number })[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      // temperature は送らない。gpt-5 系は指定すると 400 で落ちる
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(blocks, vocabulary) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: RESPONSE_SCHEMA,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${err}`);
  }

  const data = await response.json();

  // 利用量を /costs に自己申告する。失敗しても抽出は止めない (集計より本処理が優先)
  const usage = data.usage;
  if (usage) {
    try {
      await recordUsage({
        provider: "openai",
        model: OPENAI_MODEL,
        feature: "akashic.testimonials",
        inputTokens: (usage.prompt_tokens ?? 0) - (usage.prompt_tokens_details?.cached_tokens ?? 0),
        cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        requests: 1,
      });
    } catch (e) {
      console.warn(`[testimonials] 利用量の記録に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) return [];

  try {
    const parsed = JSON.parse(content);
    const results: (ExtractionResult & { index: number })[] = parsed.results || [];
    return results;
  } catch {
    console.error("Failed to parse OpenAI response:", content);
    return [];
  }
}

interface WindowedContext {
  assetId: string;
  text: string; // merged window text
  speaker: string;
  sourceUrl: string | null;
  sourceDate: Date | null;
  linkedEntities: string;
}

/**
 * Given mentions grouped by asset, build ±1 block windows with merging.
 * This ensures short blocks get surrounding context while avoiding duplicates.
 */
async function buildWindowedContexts(
  mentions: MentionResult[]
): Promise<WindowedContext[]> {
  // Group mentions by assetId + textId (same text body)
  const byText = new Map<string, MentionResult[]>();
  for (const m of mentions) {
    const key = `${m.assetId}::${m.textId}`;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key)!.push(m);
  }

  const windows: WindowedContext[] = [];

  for (const [, assetMentions] of byText) {
    const first = assetMentions[0];

    // Fetch the full text to split into blocks ourselves
    const assetText = await prismaInternal.assetText.findUnique({
      where: { id: first.textId },
      select: { content: true },
    });
    if (!assetText) continue;

    const allBlocks = assetText.content.split(/\n{2,}/).filter((b) => b.trim());
    if (allBlocks.length === 0) continue;

    // Find indices of blocks that matched (contain an alias)
    const matchedIndices = new Set<number>();
    for (const m of assetMentions) {
      const blockNorm = m.block.trim();
      for (let i = 0; i < allBlocks.length; i++) {
        if (allBlocks[i].trim() === blockNorm) {
          matchedIndices.add(i);
          break;
        }
      }
    }

    // Build ±1 windows around each matched index
    const windowRanges: [number, number][] = [];
    for (const idx of Array.from(matchedIndices).sort((a, b) => a - b)) {
      const start = Math.max(0, idx - 1);
      const end = Math.min(allBlocks.length - 1, idx + 1);
      windowRanges.push([start, end]);
    }

    // Merge overlapping windows
    const merged: [number, number][] = [];
    for (const range of windowRanges) {
      if (merged.length === 0 || range[0] > merged[merged.length - 1][1] + 1) {
        merged.push(range);
      } else {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], range[1]);
      }
    }

    // Create windowed contexts
    const speaker = parseSpeakerFromLinkedEntities(first.linkedEntities);
    const sourceUrl = parseSourceUrl(first.sourceInfo);
    const sourceDate = first.canonicalDate;

    for (const [start, end] of merged) {
      const text = allBlocks.slice(start, end + 1).join("\n");
      windows.push({
        assetId: first.assetId,
        text: text.slice(0, 800), // Cap at 800 chars per window
        speaker,
        sourceUrl,
        sourceDate,
        linkedEntities: first.linkedEntities,
      });
    }
  }

  return windows;
}

/**
 * Extract personality testimonials from blog mentions using OpenAI.
 * Processes incrementally (only new mentions since last extraction).
 * Uses ±1 block windowed context with merging for better extraction accuracy.
 */
export async function extractTestimonials(options: ExtractOptions): Promise<{
  processed: number;
  extracted: number;
  skipped: number;
}> {
  const { entityId, limit = 200, sinceDate, assetId, clearance } = options;

  const entity = await prismaInternal.entity.findUnique({ where: { id: entityId } });
  const entityName = entity?.canonicalName || "";

  let filtered: MentionResult[];

  if (assetId) {
    // Scoped mode: only check the specific asset's text (no full-table scan)
    const asset = await prismaInternal.asset.findUnique({
      where: { id: assetId },
      include: {
        texts: { where: { textType: "body" }, take: 1 },
        entities: { include: { entity: true } },
        sourceRecords: true,
      },
    });
    if (!asset || !asset.texts[0] || asset.sourceType !== "web") {
      return { processed: 0, extracted: 0, skipped: 0 };
    }
    const text = asset.texts[0];
    const aliases = (entity?.aliases as string[]) || [];
    const searchTerms = [entity?.canonicalName, ...aliases].filter(Boolean) as string[];
    const contentLower = text.content.toLowerCase();
    const hasMatch = searchTerms.some((term) => contentLower.includes(term.toLowerCase()));
    if (!hasMatch) {
      return { processed: 0, extracted: 0, skipped: 0 };
    }
    const linkedEntities = asset.entities
      .map((ae) => `${ae.entity.canonicalName}${ae.roleLabel ? ` (${ae.roleLabel})` : ""}`)
      .join(", ");
    const sourceInfo = asset.sourceRecords
      .map((sr) => `${sr.sourceKind}${sr.url ? `: ${sr.url}` : ""}${sr.publisher ? ` [${sr.publisher}]` : ""}`)
      .join("; ");
    const speaker = parseSpeakerFromLinkedEntities(linkedEntities);
    if (speaker === entityName) {
      return { processed: 0, extracted: 0, skipped: 0 };
    }
    // Build blocks from the text content
    const blocks = text.content.split(/\n{2,}/).filter((b) => b.trim());
    const mentions: MentionResult[] = [];
    for (const block of blocks) {
      const blockLower = block.toLowerCase();
      const matched = searchTerms.filter((t) => blockLower.includes(t.toLowerCase()));
      if (matched.length === 0) continue;
      mentions.push({
        assetId: asset.id,
        assetTitle: asset.title,
        assetKind: asset.kind,
        assetSourceType: asset.sourceType,
        textId: text.id,
        textType: text.textType,
        matchedAliases: matched,
        block: block.trim(),
        canonicalDate: asset.canonicalDate,
        createdAt: asset.createdAt,
        linkedEntities,
        sourceInfo,
      });
    }
    filtered = mentions;
  } else {
    // Full scan mode (for manual/batch extraction). Pass the caller's clearance
    // so RLS lets the mention search see internal/restricted assets — without it
    // searchMentions defaults to "public" and misses all classified content.
    const mentions = await searchMentions(entityId, {
      since: sinceDate,
      clearance: clearance ?? "public",
    });
    filtered = mentions.filter((m) => {
      if (m.assetSourceType !== "web" || m.textType !== "body") return false;
      const speaker = parseSpeakerFromLinkedEntities(m.linkedEntities);
      return speaker !== entityName;
    });
  }

  // Get existing testimonials to avoid reprocessing
  const existingQuotes = await prismaInternal.testimonial.findMany({
    where: { entityId },
    select: { assetId: true, quote: true },
  });
  const existingSet = new Set(
    existingQuotes.map((t) => `${t.assetId}::${t.quote.slice(0, 50)}`)
  );
  // Track assets that already have any testimonial (processed before)
  const processedAssetIds = new Set(existingQuotes.map((t) => t.assetId));

  // Build windowed contexts (±1 blocks, merged)
  // Exclude windows from assets already processed to ensure new windows get reached
  const allWindows = await buildWindowedContexts(filtered);
  const windows = allWindows.filter((w) => !processedAssetIds.has(w.assetId));

  // Limit processing
  const toProcess = windows.slice(0, limit);

  let extracted = 0;
  let skipped = 0;

  // 既存の言われ方を LLM に見せて、同じ意味は同じ表記に寄せさせる
  const vocabulary = toProcess.length > 0 ? await loadTraitVocabulary(entityId) : [];

  // Process in batches
  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    const blocks = batch.map((w, idx) => ({
      index: idx, // Use batch-local index (0-based per batch)
      text: w.text,
      speaker: w.speaker,
    }));

    const results = await callOpenAI(blocks, vocabulary);

    for (const result of results) {
      if (!result.is_personality || result.confidence < 0.4) {
        skipped++;
        continue;
      }

      // Map back to batch using the index field from structured output
      const window = batch[result.index];
      if (!window) continue;

      const quote = result.quote || window.text.slice(0, 200);
      const checkKey = `${window.assetId}::${quote.slice(0, 50)}`;
      if (existingSet.has(checkKey)) {
        skipped++;
        continue;
      }

      // Check for similar quotes from the same asset (prevent near-duplicates)
      const isDuplicate = [...existingSet].some((key) => {
        if (!key.startsWith(window.assetId + "::")) return false;
        const existingPrefix = key.split("::")[1];
        // If the first 20 chars match, consider it a duplicate
        return existingPrefix && quote.slice(0, 20) === existingPrefix.slice(0, 20);
      });
      if (isDuplicate) {
        skipped++;
        continue;
      }

      try {
        await prismaInternal.testimonial.create({
          data: {
            assetId: window.assetId,
            entityId,
            quote,
            trait: normalizeTrait(result.trait || ""),
            category: mapCategory(result.category),
            speakerName: window.speaker,
            sourceUrl: window.sourceUrl,
            sourceDate: window.sourceDate,
            status: "pending",
            confidence: result.confidence,
          },
        });
        existingSet.add(checkKey);
        extracted++;
      } catch (err: unknown) {
        // Unique constraint violation = duplicate, skip
        if (err instanceof Error && err.message.includes("Unique constraint")) {
          skipped++;
        } else {
          console.error("Failed to create testimonial:", err);
        }
      }
    }
  }

  return { processed: toProcess.length, extracted, skipped };
}

/**
 * List testimonials with filters.
 */
export async function listTestimonials(options: {
  entityId?: string;
  status?: TestimonialStatus;
  category?: TestimonialCategory;
  page?: number;
  perPage?: number;
  clearance: string;
}) {
  const { entityId, status, category, page = 1, perPage = 50, clearance } = options;

  return withClearance(clearance, async (tx) => {
    const where = {
      ...(entityId && { entityId }),
      ...(status && { status }),
      ...(category && { category }),
    };

    const [items, total] = await Promise.all([
      tx.testimonial.findMany({
        where,
        orderBy: [{ confidence: "desc" }, { sourceDate: "desc" }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      tx.testimonial.count({ where }),
    ]);

    return { items, total, page, perPage };
  });
}

/**
 * Update testimonial status (approve/reject).
 */
export async function reviewTestimonial(
  id: string,
  status: "approved" | "rejected",
  clearance: string
) {
  return withClearance(clearance, async (tx) => {
    return tx.testimonial.update({
      where: { id },
      data: { status, reviewedAt: new Date() },
    });
  });
}
