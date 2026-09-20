import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { invalidateAnnouncements } from "@/lib/cache";
import {
  AnnouncementInputError,
  deleteAnnouncement,
  getAnnouncementById,
  renderAnnouncementBodies,
  updateAnnouncement,
} from "@/lib/domain/announcements";
import { UpdateAnnouncementSchema, parsePublishedAt, projectAnnouncement } from "@/lib/announcements/api";
import { formatZodError } from "@/lib/zod-error";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const row = await getAnnouncementById(id);
  if (!row) return NextResponse.json({ error: "Announcement not found" }, { status: 404 });
  const html = await renderAnnouncementBodies([row]);
  return NextResponse.json(projectAnnouncement(row, html.get(row.id) ?? ""));
}

/** 部分更新。省略した項目は変えない (url は null で外す、publishedAt は null で下書きに戻す) */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = UpdateAnnouncementSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const current = await getAnnouncementById(id);
  if (!current) return NextResponse.json({ error: "Announcement not found" }, { status: 404 });

  const body = parsed.data;
  const publishedAt = parsePublishedAt(body.publishedAt);
  try {
    const row = await updateAnnouncement(
      id,
      {
        title: body.title ?? current.title,
        body: body.body ?? current.body,
        kind: body.kind ?? current.kind,
        url: body.url === undefined ? current.url : body.url,
        publishedAt: publishedAt === undefined ? current.publishedAt : publishedAt,
      },
      auth.id
    );
    invalidateAnnouncements();
    const html = await renderAnnouncementBodies([row]);
    return NextResponse.json(projectAnnouncement(row, html.get(row.id) ?? ""));
  } catch (e) {
    if (e instanceof AnnouncementInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const current = await getAnnouncementById(id);
  if (!current) return NextResponse.json({ error: "Announcement not found" }, { status: 404 });

  await deleteAnnouncement(id, auth.id);
  invalidateAnnouncements();
  return NextResponse.json({ success: true });
}
