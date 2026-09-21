import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listSongs } from "@/lib/domain/songs";
import { ListSongsQuerySchema, listSongsQueryInput, projectSong } from "@/lib/songs/api";
import { formatZodError } from "@/lib/zod-error";

/**
 * 曲マスタの一覧 (#167)。公開サイトのディスコグラフィ / 参加楽曲ページ用。
 * `performanceCount` はキーの持ち主に見えるライブでの披露回数
 */
export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const parsed = ListSongsQuerySchema.safeParse(listSongsQueryInput(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  const rows = await listSongs(auth, {
    q: parsed.data.q,
    participation: parsed.data.participation,
    orphan: parsed.data.orphan === "1",
  });
  return NextResponse.json({ items: rows.map(projectSong) });
}
