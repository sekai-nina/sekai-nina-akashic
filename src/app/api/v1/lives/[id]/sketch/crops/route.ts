import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getLive, LiveInputError } from "@/lib/domain/lives";
import { saveSketchCrops } from "@/lib/domain/live-sketch";
import { SketchCropsSchema } from "@/lib/meetgreet/api";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

/**
 * 参照写真の切り抜き枠を保存する (#136)。
 *
 * ツーショットの写真をそのまま参照に渡すと隣の人の服を拾うので、本人のところだけを
 * 送れるようにする。**枠は画像に対する割合 (0〜1)**。生成は Drive の原本を使うので、
 * 画素で渡すと画面で見ている縮小版とずれる。
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
  const parsed = SketchCropsSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const live = await getLive(auth, id);
  if (!live) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const crops = await saveSketchCrops(auth, live, parsed.data);
    return NextResponse.json({ crops });
  } catch (e) {
    if (e instanceof LiveInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
