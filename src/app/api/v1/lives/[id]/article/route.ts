import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getLive } from "@/lib/domain/lives";
import { handleArticleGenerate } from "@/lib/domain/article-generate-route";
import { ArticleGenerateSchema } from "@/lib/meetgreet/api";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

/** TikTok の短縮 URL の解決で外部に出るので、少し余裕を持たせる */
export const maxDuration = 120;

/**
 * ライブ記事を生成する (#151)。本体は `POST /meetgreets/:id/article` と同じ
 * (`dryRun` / `expectedDigest` / `exclude` / `restore`)。公演の表の区間は追記のたびに作り直す
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

  const live = await getLive(auth, id);
  if (!live) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return handleArticleGenerate(auth, { kind: "live", live }, parsed.data);
}
