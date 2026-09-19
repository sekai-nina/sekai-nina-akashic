/**
 * 記念日 (初めて〇〇した日) の CRUD と集計。
 *
 * 公開サイトの「今日は〇〇の日」/ 記念日ページの正。366 日を埋めるのが目標なので、
 * 一覧は月日順に並べ、埋まった日数 (同じ月日は 1 と数える) を出せるようにしてある。
 * date は JST の "YYYY-MM-DD" 文字列 (MeetGreet.date と同形)。
 */
import type { ClearanceLevel, Prisma } from "@prisma/client";
import { prisma, withClearance } from "@/lib/db";
import { assertClearance } from "@/lib/classification";
import { isValidDateString } from "@/lib/utils";
import { logAudit } from "./audit";

/** 埋める対象の日数 (2/29 を含む) */
export const ANNIVERSARY_TOTAL_DAYS = 366;

export class AnniversaryInputError extends Error {}

const include = {
  asset: {
    select: {
      id: true,
      title: true,
      kind: true,
      canonicalDate: true,
      sourceRecords: {
        select: { url: true, publisher: true, title: true },
        orderBy: { createdAt: "asc" as const },
        take: 1,
      },
    },
  },
  article: { select: { id: true, shortId: true, path: true, slug: true, title: true } },
} satisfies Prisma.AnniversaryInclude;

export type AnniversaryRow = Prisma.AnniversaryGetPayload<{ include: typeof include }>;

export interface AnniversaryInput {
  date: string;
  title: string;
  description?: string;
  assetId?: string | null;
  sourceUrl?: string | null;
  articleId?: string | null;
  classification?: ClearanceLevel;
}

/** "YYYY-MM-DD" → "MM-DD" (毎年の記念日のキー) */
export function monthDayOf(date: string): string {
  return date.slice(5, 10);
}

/** 埋まった日数 (同じ月日の記念日が複数あっても 1) */
export function countFilledDays(rows: { date: string }[]): number {
  return new Set(rows.map((r) => monthDayOf(r.date))).size;
}

/** 一覧を月ごと (1〜12) にまとめる。月内は月日 → 年の順 */
export function groupByMonth<T extends { date: string }>(rows: T[]): { month: number; items: T[] }[] {
  const byMonth = new Map<number, T[]>();
  for (const r of sortByMonthDay(rows)) {
    const m = Number(r.date.slice(5, 7));
    const list = byMonth.get(m) ?? [];
    list.push(r);
    byMonth.set(m, list);
  }
  return Array.from({ length: 12 }, (_, i) => ({ month: i + 1, items: byMonth.get(i + 1) ?? [] }));
}

export function sortByMonthDay<T extends { date: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const k = monthDayOf(a.date).localeCompare(monthDayOf(b.date));
    return k !== 0 ? k : a.date.localeCompare(b.date);
  });
}

function normalizeInput(data: AnniversaryInput, clearance: string) {
  const date = data.date.trim();
  if (!isValidDateString(date)) {
    throw new AnniversaryInputError("日付は暦に実在する YYYY-MM-DD で指定してください");
  }
  const title = data.title.trim();
  if (!title) throw new AnniversaryInputError("呼び名は必須です");
  if (title.length > 100) throw new AnniversaryInputError("呼び名は 100 文字以内です");
  const description = (data.description ?? "").trim();
  if (description.length > 1000) throw new AnniversaryInputError("説明は 1000 文字以内です");
  const sourceUrl = (data.sourceUrl ?? "").trim() || null;
  if (sourceUrl && !/^https?:\/\//.test(sourceUrl)) {
    throw new AnniversaryInputError("出典 URL は http(s) で始めてください");
  }
  if (data.classification) assertClearance(clearance, data.classification);
  return {
    date,
    title,
    description,
    sourceUrl,
    assetId: data.assetId?.trim() || null,
    articleId: data.articleId?.trim() || null,
  };
}

export async function listAnniversaries(clearance: string): Promise<AnniversaryRow[]> {
  const rows = await withClearance(clearance, (tx) =>
    tx.anniversary.findMany({ include, orderBy: [{ date: "asc" }, { createdAt: "asc" }] })
  );
  return sortByMonthDay(rows);
}

export async function getAnniversaryById(id: string, clearance: string): Promise<AnniversaryRow | null> {
  return withClearance(clearance, (tx) => tx.anniversary.findUnique({ where: { id }, include }));
}

/** 同じアセットから既に作った記念日 (アセットページで「登録済み」を出すため) */
export async function listAnniversariesForAsset(assetId: string, clearance: string) {
  return withClearance(clearance, (tx) =>
    tx.anniversary.findMany({
      where: { assetId },
      select: { id: true, date: true, title: true },
      orderBy: { date: "asc" },
    })
  );
}

export async function createAnniversary(
  data: AnniversaryInput,
  clearance: string,
  actorId?: string | null
): Promise<AnniversaryRow> {
  const input = normalizeInput(data, clearance);

  const row = await withClearance(clearance, async (tx) => {
    await assertLinks(tx, input.assetId, input.articleId);
    return tx.anniversary.create({
      data: { ...input, classification: data.classification ?? "internal" },
      include,
    });
  });

  await logAudit({
    actorId,
    action: "anniversary.create",
    targetType: "Anniversary",
    targetId: row.id,
    metadata: { date: row.date, title: row.title },
  });
  return row;
}

export async function updateAnniversary(
  id: string,
  data: AnniversaryInput,
  clearance: string,
  actorId?: string | null
): Promise<AnniversaryRow> {
  const input = normalizeInput(data, clearance);

  const row = await withClearance(clearance, async (tx) => {
    const existing = await tx.anniversary.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new Error("Anniversary not found");
    await assertLinks(tx, input.assetId, input.articleId);
    return tx.anniversary.update({
      where: { id },
      data: { ...input, ...(data.classification ? { classification: data.classification } : {}) },
      include,
    });
  });

  await logAudit({
    actorId,
    action: "anniversary.update",
    targetType: "Anniversary",
    targetId: id,
    metadata: { date: row.date, title: row.title },
  });
  return row;
}

export async function deleteAnniversary(id: string, clearance: string, actorId?: string | null) {
  await withClearance(clearance, async (tx) => {
    const existing = await tx.anniversary.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new Error("Anniversary not found");
    await tx.anniversary.delete({ where: { id } });
  });
  await logAudit({ actorId, action: "anniversary.delete", targetType: "Anniversary", targetId: id });
}

/**
 * 紐づけ先の存在確認。Asset は RLS 下 (= 自分のクリアランスで見えるものだけ)、
 * Article は非保護テーブルなので素の prisma でよいがトランザクション内で引く。
 */
async function assertLinks(
  tx: Prisma.TransactionClient,
  assetId: string | null,
  articleId: string | null
) {
  if (assetId) {
    const asset = await tx.asset.findUnique({ where: { id: assetId }, select: { id: true } });
    if (!asset) throw new AnniversaryInputError("出典アセットが見つかりません");
  }
  if (articleId) {
    const article = await tx.article.findUnique({ where: { id: articleId }, select: { id: true } });
    if (!article) throw new AnniversaryInputError("記事が見つかりません");
  }
}

/** 記事ピッカー用 (id・short_id・タイトル)。非保護テーブルなので素の prisma */
export async function listArticlesForAnniversaryPicker() {
  return prisma.article.findMany({
    where: { draft: false },
    select: { id: true, shortId: true, title: true, type: true },
    orderBy: { title: "asc" },
  });
}
