/**
 * お知らせ (公開サイトに出す運営からの知らせ) の CRUD と描画。
 *
 * 公開サイトのトップ「お知らせ」と /news の正。「機能を足した」「記事を更新した」を X に
 * 投稿しなくても伝わるようにするためのもの。publishedAt が null の行は下書き。
 * 非保護テーブル (Article と同じ) なので素の prisma でよい。
 */
import type { AnnouncementKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { renderArticleBody } from "@/lib/articles/render";
import { getArticleTitleIndex } from "./articles";
import { logAudit } from "./audit";

export class AnnouncementInputError extends Error {}

export type AnnouncementRow = Prisma.AnnouncementGetPayload<Record<string, never>>;

export const ANNOUNCEMENT_KINDS: AnnouncementKind[] = ["feature", "article", "info"];

export interface AnnouncementInput {
  title: string;
  body?: string;
  kind?: AnnouncementKind;
  url?: string | null;
  /** null で下書きに戻す */
  publishedAt?: Date | null;
}

function normalizeInput(data: AnnouncementInput) {
  const title = data.title.trim();
  if (!title) throw new AnnouncementInputError("見出しは必須です");
  if (title.length > 120) throw new AnnouncementInputError("見出しは 120 文字以内です");
  const body = (data.body ?? "").replace(/\r\n/g, "\n").trim();
  if (body.length > 5000) throw new AnnouncementInputError("本文は 5000 文字以内です");
  const kind = data.kind ?? "info";
  if (!ANNOUNCEMENT_KINDS.includes(kind)) throw new AnnouncementInputError("種類が不正です");
  const url = (data.url ?? "").trim() || null;
  // サイト内は "/anniversaries" のようなパス、外は絶対 URL。相対パスや javascript: は通さない
  if (url && !/^(\/[^/]|https?:\/\/)/.test(url)) {
    throw new AnnouncementInputError("リンクは / で始まるサイト内パスか http(s) の URL にしてください");
  }
  if (url && url.length > 2000) throw new AnnouncementInputError("リンクが長すぎます");
  const publishedAt = data.publishedAt ?? null;
  if (publishedAt && Number.isNaN(publishedAt.getTime())) {
    throw new AnnouncementInputError("公開日時が不正です");
  }
  return { title, body, kind, url, publishedAt };
}

/** 新しい順。published は公開済みだけ (サイト向け)、all は下書きも (管理画面向け) */
export async function listAnnouncements(
  status: "published" | "all",
  limit = 100
): Promise<AnnouncementRow[]> {
  return prisma.announcement.findMany({
    where: status === "published" ? { publishedAt: { not: null, lte: new Date() } } : {},
    // 下書きは publishedAt が無いので作成日で並ぶ。公開済みを公開日の新しい順に
    orderBy: [{ publishedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
    take: limit,
  });
}

export async function getAnnouncementById(id: string): Promise<AnnouncementRow | null> {
  return prisma.announcement.findUnique({ where: { id } });
}

export async function createAnnouncement(
  data: AnnouncementInput,
  actorId?: string | null
): Promise<AnnouncementRow> {
  const input = normalizeInput(data);
  const row = await prisma.announcement.create({ data: input });
  await logAudit({
    actorId,
    action: "announcement.create",
    targetType: "Announcement",
    targetId: row.id,
    metadata: { title: row.title, kind: row.kind, published: !!row.publishedAt },
  });
  return row;
}

export async function updateAnnouncement(
  id: string,
  data: AnnouncementInput,
  actorId?: string | null
): Promise<AnnouncementRow> {
  const input = normalizeInput(data);
  const existing = await prisma.announcement.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new Error("Announcement not found");
  const row = await prisma.announcement.update({ where: { id }, data: input });
  await logAudit({
    actorId,
    action: "announcement.update",
    targetType: "Announcement",
    targetId: id,
    metadata: { title: row.title, kind: row.kind, published: !!row.publishedAt },
  });
  return row;
}

export async function deleteAnnouncement(id: string, actorId?: string | null) {
  const existing = await prisma.announcement.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new Error("Announcement not found");
  await prisma.announcement.delete({ where: { id } });
  await logAudit({ actorId, action: "announcement.delete", targetType: "Announcement", targetId: id });
}

/**
 * 本文の Markdown を公開サイトに載せる HTML にする。記事と同じ描画 (サニタイズ込み) で、
 * [[記事名]] は公開サイトの記事 URL (/articles/<shortId>) になる。
 * 一覧で何件も描くときはタイトル索引を 1 回だけ引いて使い回す。
 */
export async function renderAnnouncementBodies(rows: AnnouncementRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (rows.every((r) => !r.body)) return out;
  const titleIndex = await getArticleTitleIndex();
  await Promise.all(
    rows.map(async (r) => {
      out.set(r.id, r.body ? await renderArticleBody(r.body, { wikilinks: titleIndex }) : "");
    })
  );
  return out;
}
