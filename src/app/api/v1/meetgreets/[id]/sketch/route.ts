import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getMeetGreet, MeetGreetInputError } from "@/lib/domain/meetgreets";
import { generateSketch } from "@/lib/domain/meetgreet-sketch";
import { GenerateSketchSchema } from "@/lib/meetgreet/api";
import { SketchConfigError, SketchError } from "@/lib/meetgreet/sketch";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

/** 画像生成は 1 分前後かかる。bot は deferred ack してから呼ぶこと */
export const maxDuration = 300;

/**
 * 服装スケッチの候補を生成する。`revisionOf` を渡すとその候補を元に作り直す。
 * 確定は POST /meetgreets/:id/sketch/select。
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

  const mg = await getMeetGreet(auth, id);
  if (!mg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const { candidates } = await generateSketch(auth, mg, parsed.data);
    return NextResponse.json({ candidates });
  } catch (e) {
    if (e instanceof MeetGreetInputError) {
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
