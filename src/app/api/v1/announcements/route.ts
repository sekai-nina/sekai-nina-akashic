import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { invalidateAnnouncements } from "@/lib/cache";
import {
  AnnouncementInputError,
  createAnnouncement,
  listAnnouncements,
  renderAnnouncementBodies,
} from "@/lib/domain/announcements";
import { CreateAnnouncementSchema, parsePublishedAt, projectAnnouncement } from "@/lib/announcements/api";
import { formatZodError } from "@/lib/zod-error";

/**
 * 新しい順。既定は公開済みだけ (公開サイトと stats Worker が読む)。
 * ?status=all で下書きも。?limit=N (既定 50、最大 200)
 */
export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") === "all" ? "all" : "published";
  const limitRaw = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;

  const rows = await listAnnouncements(status, limit);
  const html = await renderAnnouncementBodies(rows);
  return NextResponse.json({
    items: rows.map((r) => projectAnnouncement(r, html.get(r.id) ?? "")),
    generatedAt: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = CreateAnnouncementSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  try {
    const row = await createAnnouncement(
      { ...parsed.data, publishedAt: parsePublishedAt(parsed.data.publishedAt) ?? null },
      auth.id
    );
    invalidateAnnouncements();
    const html = await renderAnnouncementBodies([row]);
    return NextResponse.json(projectAnnouncement(row, html.get(row.id) ?? ""), { status: 201 });
  } catch (e) {
    if (e instanceof AnnouncementInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
