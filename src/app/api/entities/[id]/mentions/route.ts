import { auth } from "@/lib/auth";
import { searchMentions } from "@/lib/domain/mentions";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const entity = await prisma.entity.findUnique({ where: { id } });
  if (!entity) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const mentions = await searchMentions(id);

  // Build CSV
  const header = "アセットタイトル,種別,テキストタイプ,マッチしたエイリアス,スニペット,日付";
  const rows = mentions.map((m) => {
    const date = m.canonicalDate
      ? m.canonicalDate.toISOString().split("T")[0]
      : m.createdAt.toISOString().split("T")[0];
    return [
      csvEscape(m.assetTitle),
      csvEscape(m.assetKind),
      csvEscape(m.textType),
      csvEscape(m.matchedAlias),
      csvEscape(m.snippet),
      date,
    ].join(",");
  });

  const csv = "\uFEFF" + [header, ...rows].join("\n");
  const filename = `mentions_${entity.canonicalName}_${new Date().toISOString().split("T")[0]}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
    },
  });
}

function csvEscape(value: string): string {
  const s = value.replace(/\n/g, " ").replace(/\r/g, "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
