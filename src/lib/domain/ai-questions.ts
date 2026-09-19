import { withClearance } from "@/lib/db";
import type { ClearanceLevel } from "@prisma/client";

/**
 * 案内AI「ふぃたん」に来た質問の記録。
 *
 * 何が聞かれているかを人が眺めて、アーカイブの穴（＝まだ記事にしていない話題）を
 * 見つけるためのもの。個人を特定できる情報は受け取らないので、行から人を辿ることはできない。
 *
 * 公開している方針文(/ai)で「最大180日間保存」と約束しているため、保存期間は
 * この RETENTION_DAYS を単一の出どころにする（延ばすなら方針文も直すこと）。
 */
export const RETENTION_DAYS = 180;

export interface AiQuestionInput {
  askedAt: Date;
  question: string;
  answer: string;
  citations: { title: string; url: string }[];
  cached: boolean;
  origin: string;
  /** 会話の続きとして聞かれたか。どの質問の続きかは持たない */
  followUp: boolean;
}

export function expiryFor(askedAt: Date): Date {
  return new Date(askedAt.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export async function recordAiQuestion(input: AiQuestionInput, clearance: string) {
  return withClearance(clearance, (tx) =>
    tx.aiQuestion.create({
      data: {
        askedAt: input.askedAt,
        question: input.question,
        answer: input.answer,
        citations: input.citations,
        citationCount: input.citations.length,
        cached: input.cached,
        origin: input.origin,
        followUp: input.followUp,
        expiresAt: expiryFor(input.askedAt),
      },
    })
  );
}

export interface ListAiQuestionsOptions {
  /** 出典が付かなかった質問だけを見る（穴の候補） */
  onlyNoHit?: boolean;
  /** 質問文・回答文の部分一致 */
  q?: string;
  take?: number;
  skip?: number;
}

export async function listAiQuestions(clearance: string, options: ListAiQuestionsOptions = {}) {
  const { onlyNoHit = false, q, take = 50, skip = 0 } = options;
  const where = {
    ...(onlyNoHit ? { citationCount: 0 } : {}),
    ...(q
      ? {
          OR: [
            { question: { contains: q, mode: "insensitive" as const } },
            { answer: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  return withClearance(clearance, async (tx) => {
    const [items, total, noHit] = await Promise.all([
      tx.aiQuestion.findMany({ where, orderBy: { askedAt: "desc" }, take, skip }),
      tx.aiQuestion.count({ where }),
      tx.aiQuestion.count({ where: { citationCount: 0 } }),
    ]);
    return { items, total, noHit };
  });
}

/** 期限切れの行を消す。方針文の「最大180日間保存」を守るための処理 */
export async function purgeExpiredAiQuestions(clearance: string): Promise<number> {
  const { count } = await withClearance(clearance, (tx) =>
    tx.aiQuestion.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  );
  return count;
}

export type { ClearanceLevel };
