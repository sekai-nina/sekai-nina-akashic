import { prisma } from "@/lib/db";
import { TestimonialCategory, TestimonialStatus } from "@prisma/client";
import { searchMentions, MentionResult } from "./mentions";

const OPENAI_MODEL = "gpt-4o-mini";
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
}

const SYSTEM_PROMPT = `あなたは日向坂46のメンバーのブログから、坂井新奈に関する人柄・性格・特徴の記述を抽出するアシスタントです。

各テキストブロックについて、以下を判断してください:
1. そのブロックが坂井新奈の人柄・性格・特徴・スキルについて語っているか
2. 単なる名前の列挙、活動報告、予定告知だけの場合は is_personality: false

**抽出対象の例:**
- 性格の描写（優しい、面白い、しっかり者など）
- ダンス・パフォーマンスの特徴
- 癖や特徴的な行動
- 外見・雰囲気の描写
- 好み・嗜好
- スキル・特技

**除外するもの:**
- 「坂井新奈ちゃんです！」のような単なる紹介
- メンバーリスト内の名前
- 「明日はにぃたんのブログです」のような事務連絡
- 活動の事実だけ（「一緒に行った」だけで性格に触れていない）

JSON配列で回答してください。各要素は:
- is_personality: boolean
- quote: string (性格に触れている部分のみ抜粋。100文字以内に要約)
- trait: string (キーワード。例: "優しい", "しなやかなダンス", "方向音痴")
- category: "personality" | "dance" | "appearance" | "habit" | "preference" | "skill" | "relationship" | "other"
- confidence: number (0-1)`;

function buildUserPrompt(blocks: { index: number; text: string; speaker: string }[]): string {
  const items = blocks.map(
    (b) => `[${b.index}] (by ${b.speaker})\n${b.text}`
  );
  return `以下の${blocks.length}個のテキストブロックを分析してください:\n\n${items.join("\n\n---\n\n")}`;
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
    dance: "dance",
    appearance: "appearance",
    habit: "habit",
    preference: "preference",
    skill: "skill",
    relationship: "relationship",
    other: "other",
  };
  return map[cat] || "other";
}

async function callOpenAI(
  blocks: { index: number; text: string; speaker: string }[]
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
      temperature: 0.1,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(blocks) },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) return [];

  try {
    const parsed = JSON.parse(content);
    // Handle various response shapes: direct array, { results: [...] }, { data: [...] }
    const results = Array.isArray(parsed)
      ? parsed
      : parsed.results || parsed.data || parsed.items || [];
    return results.map((r: ExtractionResult & { index?: number }, i: number) => ({
      ...r,
      index: r.index ?? i,
    }));
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
    const assetText = await prisma.assetText.findUnique({
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
  const { entityId, limit = 200, sinceDate } = options;

  // Get mentions (with date filter at DB level for efficiency)
  const mentions = await searchMentions(entityId, { since: sinceDate });

  // Filter to blog posts only (sourceType: web, textType: body)
  // Exclude self-mentions (where the subject entity is the author)
  const entity = await prisma.entity.findUnique({ where: { id: entityId } });
  const entityName = entity?.canonicalName || "";
  const filtered = mentions.filter((m) => {
    if (m.assetSourceType !== "web" || m.textType !== "body") return false;
    // Exclude posts authored by the subject themselves
    const speaker = parseSpeakerFromLinkedEntities(m.linkedEntities);
    return speaker !== entityName;
  });

  // Get existing testimonials to avoid reprocessing
  const existingQuotes = await prisma.testimonial.findMany({
    where: { entityId },
    select: { assetId: true, quote: true },
  });
  const existingSet = new Set(
    existingQuotes.map((t) => `${t.assetId}::${t.quote.slice(0, 50)}`)
  );

  // Build windowed contexts (±1 blocks, merged)
  const windows = await buildWindowedContexts(filtered);

  // Limit processing
  const toProcess = windows.slice(0, limit);

  let extracted = 0;
  let skipped = 0;

  // Process in batches
  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    const blocks = batch.map((w, idx) => ({
      index: idx, // Use batch-local index (0-based per batch)
      text: w.text,
      speaker: w.speaker,
    }));

    const results = await callOpenAI(blocks);

    for (let ri = 0; ri < results.length; ri++) {
      const result = results[ri];
      if (!result.is_personality || result.confidence < 0.4) {
        skipped++;
        continue;
      }

      // Map back to batch using array position (OpenAI may not return index field)
      const window = batch[ri];
      if (!window) continue;

      const quote = result.quote || window.text.slice(0, 200);
      const checkKey = `${window.assetId}::${quote.slice(0, 50)}`;
      if (existingSet.has(checkKey)) {
        skipped++;
        continue;
      }

      try {
        await prisma.testimonial.create({
          data: {
            assetId: window.assetId,
            entityId,
            quote,
            trait: result.trait || "",
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
}) {
  const { entityId, status, category, page = 1, perPage = 50 } = options;

  const where = {
    ...(entityId && { entityId }),
    ...(status && { status }),
    ...(category && { category }),
  };

  const [items, total] = await Promise.all([
    prisma.testimonial.findMany({
      where,
      orderBy: [{ confidence: "desc" }, { sourceDate: "desc" }],
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.testimonial.count({ where }),
  ]);

  return { items, total, page, perPage };
}

/**
 * Update testimonial status (approve/reject).
 */
export async function reviewTestimonial(
  id: string,
  status: "approved" | "rejected"
) {
  return prisma.testimonial.update({
    where: { id },
    data: { status, reviewedAt: new Date() },
  });
}
