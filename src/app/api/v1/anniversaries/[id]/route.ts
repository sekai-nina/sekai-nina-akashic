import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { invalidateAnniversaries } from "@/lib/cache";
import { assertClearance, isClassificationDowngrade } from "@/lib/classification";
import {
  AnniversaryInputError,
  deleteAnniversary,
  getAnniversaryById,
  updateAnniversary,
} from "@/lib/domain/anniversaries";
import { UpdateAnniversarySchema, projectAnniversary } from "@/lib/anniversaries/api";
import { formatZodError } from "@/lib/zod-error";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const row = await getAnniversaryById(id, auth.clearance);
  if (!row) return NextResponse.json({ error: "Anniversary not found" }, { status: 404 });
  return NextResponse.json(projectAnniversary(row));
}

/** 部分更新。省略した項目は変えない (null で紐づけを外す) */
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
  const parsed = UpdateAnniversarySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const current = await getAnniversaryById(id, auth.clearance);
  if (!current) return NextResponse.json({ error: "Anniversary not found" }, { status: 404 });

  // Place と同じく、API キー経由の機密レベルの引き上げ / 引き下げはアプリ層でも検査する
  const body = parsed.data;
  if (body.classification) {
    try {
      assertClearance(auth.clearance, body.classification);
    } catch {
      return NextResponse.json({ error: "Cannot set classification above your clearance level" }, { status: 403 });
    }
    if (isClassificationDowngrade(current.classification, body.classification)) {
      return NextResponse.json(
        { error: `Cannot lower classification (${current.classification} -> ${body.classification}) via API key` },
        { status: 403 }
      );
    }
  }

  try {
    const row = await updateAnniversary(
      id,
      {
        date: body.date ?? current.date,
        title: body.title ?? current.title,
        description: body.description ?? current.description,
        assetId: body.assetId === undefined ? current.assetId : body.assetId,
        sourceUrl: body.sourceUrl === undefined ? current.sourceUrl : body.sourceUrl,
        articleId: body.articleId === undefined ? current.articleId : body.articleId,
        classification: body.classification,
      },
      auth.clearance,
      auth.id
    );
    invalidateAnniversaries();
    return NextResponse.json(projectAnniversary(row));
  } catch (e) {
    if (e instanceof AnniversaryInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const current = await getAnniversaryById(id, auth.clearance);
  if (!current) return NextResponse.json({ error: "Anniversary not found" }, { status: 404 });

  await deleteAnniversary(id, auth.clearance, auth.id);
  invalidateAnniversaries();
  return NextResponse.json({ success: true });
}
