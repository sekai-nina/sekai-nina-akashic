import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getMeetGreet, MeetGreetInputError } from "@/lib/domain/meetgreets";
import {
  previewMeetGreetArticle,
  saveMeetGreetArticle,
} from "@/lib/domain/meetgreet-article-save";
import { ArticleGenerateSchema } from "@/lib/meetgreet/api";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

/** TikTok の短縮 URL の解決で外部に出るので、少し余裕を持たせる */
export const maxDuration = 120;

/**
 * 記事を生成する。既存記事が紐づいていれば**増えた分だけ追記**、無ければ新規作成。
 * `dryRun: true` なら書き込まず、適用後の本文と増える行だけを返す。
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let raw: unknown = {};
  try {
    const text = await request.text();
    if (text.trim()) raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ArticleGenerateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const mg = await getMeetGreet(auth, id);
  if (!mg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    if (parsed.data.dryRun) {
      const preview = await previewMeetGreetArticle(auth, { ...mg, format: mg.format });
      return NextResponse.json({
        mode: preview.mode,
        title: preview.title,
        body: preview.body,
        addedLines: preview.addedLines,
        newSources: preview.newSources,
        droppedByClearance: preview.droppedByClearance,
        empty: preview.empty,
        shortId: preview.shortId,
      });
    }
    const result = await saveMeetGreetArticle(auth, { ...mg, format: mg.format });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({
      mode: result.mode,
      shortId: result.shortId,
      added: result.added,
      sources: result.sources,
    });
  } catch (e) {
    if (e instanceof MeetGreetInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
