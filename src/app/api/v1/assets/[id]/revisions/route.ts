import { NextResponse } from "next/server";
import { Prisma, TextType } from "@prisma/client";
import { requireApiAuth } from "@/lib/api-auth";
import { withClearance } from "@/lib/db";
import { addTextRevision, listTextRevisions } from "@/lib/domain/text-revisions";

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** 本文の版の一覧 (#262)。テキストごとに新しい順 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const asset = await withClearance(auth.clearance, (tx) =>
    tx.asset.findUnique({ where: { id }, select: { id: true } })
  );
  if (!asset) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  const revisions = await listTextRevisions(id, auth.clearance);
  return NextResponse.json({ revisions });
}

/**
 * 公式から取り直した本文を送る (#262)。現行と違えば新しい版として積み、AssetText を書き換える。
 * body: { content: string, textType?: "body" (既定) | TextType, fetchedAt?: ISO 8601 (既定は今) }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { content, textType = "body", fetchedAt } = (body ?? {}) as {
    content?: unknown;
    textType?: unknown;
    fetchedAt?: unknown;
  };

  if (typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }
  if (typeof textType !== "string" || !Object.values(TextType).includes(textType as TextType)) {
    return NextResponse.json({ error: `Invalid textType: ${String(textType)}` }, { status: 400 });
  }
  // 日付だけ・時差なしは UTC 扱いになって JST で 9 時間ずれるので、時刻と時差 (Z / +09:00) まで要る
  let fetchedAtDate = new Date();
  if (fetchedAt !== undefined) {
    const valid = typeof fetchedAt === "string" && ISO_DATETIME_RE.test(fetchedAt);
    fetchedAtDate = new Date(valid ? fetchedAt : NaN);
    if (Number.isNaN(fetchedAtDate.getTime())) {
      return NextResponse.json(
        { error: "fetchedAt must be an ISO 8601 datetime with offset (e.g. 2026-08-27T21:10:00+09:00)" },
        { status: 400 }
      );
    }
  }

  let result;
  try {
    result = await addTextRevision(
      { assetId: id, textType: textType as TextType, content, fetchedAt: fetchedAtDate },
      auth.clearance
    );
  } catch (e) {
    // Asset 行のロックで直列にしているが、念のため版番号の衝突は 409 で返す (送り直せば unchanged になる)
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "Conflicting revision, retry" }, { status: 409 });
    }
    throw e;
  }
  if (!result) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }
  return NextResponse.json(result, { status: result.status === "unchanged" ? 200 : 201 });
}
