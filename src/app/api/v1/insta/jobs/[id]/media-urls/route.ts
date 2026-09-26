import { NextResponse } from "next/server";
import { z } from "zod";
import { registerStoryMediaUrls } from "@/lib/domain/insta-jobs";
import { instaJobErrorResponse, instaJobToJson, requireInstaJobAuth } from "@/lib/insta/api";
import { MAX_MEDIA_URLS } from "@/lib/insta/jobs";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

// CDN からの取得 + Drive へのアップロード + サムネイル生成を URL の本数ぶん行う
export const maxDuration = 300;

const Body = z
  .object({ urls: z.array(z.string().min(1).max(2000)).min(1).max(MAX_MEDIA_URLS) })
  .strict();

/**
 * iPhone が見つけた媒体 URL を受け取り、**サーバが取りに行って** Asset にする (#196)。
 *
 * iPhone に落とさせると CDN のホスト名が変わるたびに iOS の許可ダイアログで止まるので、
 * ラッパー Shortcut は URL だけ送ればよい (upload-url → PUT → result の 3 往復が 1 回になる)。
 * 受け付けるのは Instagram の CDN の https URL だけ。
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireInstaJobAuth(request, "worker");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  try {
    const res = await registerStoryMediaUrls(id, parsed.data.urls, { id: auth.id, clearance: auth.clearance });
    return NextResponse.json(
      { ...instaJobToJson(res.job), registered: res.files.length, files: res.files, failed: res.failed },
      { status: res.files.length > 0 ? 201 : 207 },
    );
  } catch (e) {
    return instaJobErrorResponse(e);
  }
}
