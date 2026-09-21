import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getLive, LiveInputError } from "@/lib/domain/lives";
import { generateSketch } from "@/lib/domain/live-sketch";
import { GenerateSketchSchema } from "@/lib/meetgreet/api";
import { SketchConfigError, SketchError } from "@/lib/meetgreet/sketch";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

/** 画像生成は 1 分前後かかる。bot は deferred ack してから呼ぶこと */
export const maxDuration = 300;

/**
 * 衣装スケッチの候補を生成する。`revisionOf` を渡すとその候補を元に作り直す。
 * 確定は POST /lives/:id/sketch/select。
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = GenerateSketchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const live = await getLive(auth, id);
  if (!live) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const { candidates } = await generateSketch(auth, live, parsed.data);
    return NextResponse.json({ candidates });
  } catch (e) {
    if (e instanceof LiveInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    // 設定漏れはこちら側の問題なので 500 (502 だと呼ばれてもいない上流のせいに見える)
    if (e instanceof SketchConfigError) throw e;
    // 画像生成・R2 の失敗は上流の問題
    if (e instanceof SketchError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    throw e;
  }
}
