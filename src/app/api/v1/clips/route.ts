import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireApiAuth } from "@/lib/api-auth";
import { invalidateDossiers } from "@/lib/cache";
import { CLIP_PERMISSION, ClipAssetNotFoundError, ClipForbiddenError, ClipInputError } from "@/lib/clips/errors";
import { createClip } from "@/lib/domain/clips";
import { formatZodError } from "@/lib/zod-error";

/** メモ・引用の上限 (docs/api.md の「10,000 字まで」) */
const MAX_TEXT_LENGTH = 10000;

const CreateClipRequestSchema = z.object({
  assetId: z.string().min(1).max(100),
  note: z.string().max(MAX_TEXT_LENGTH).optional(),
  excerpt: z.string().max(MAX_TEXT_LENGTH).optional(),
  /** 返信した人の Discord 名など。監査ログに残すだけ */
  requestedBy: z.string().max(200).optional(),
});

/**
 * クリップを 1 件作る (#286)。Discord bot が、トークの投稿への返信から叩く。
 * `clip` か `write` を持つキーだけ。
 *
 * 中身は画面の「クリップ」と同じ `createClip`。引用の位置は本文から探し、
 * 見つからなければ文字列だけ保存する (`located: false`)。
 * 作成者はキーの持ち主 (bot 専用ユーザー) になる
 */
export async function POST(request: Request) {
  const auth = await requireApiAuth(request, [CLIP_PERMISSION, "write"]);
  if (auth instanceof NextResponse) return auth;
  // 画面の createClipAction と同じく viewer を弾く。プールの所有者は canEditDossier が
  // role を見ずに通すので、プールを最初に作ったキーが viewer だと素通りになる
  if (auth.role !== "admin" && auth.role !== "member") {
    return NextResponse.json({ error: "クリップを作る権限がありません" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = CreateClipRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  const { assetId, note, excerpt, requestedBy } = parsed.data;

  try {
    const item = await createClip(auth, {
      assetId,
      note,
      excerpt,
      auditMetadata: {
        apiKeyId: auth.apiKeyId,
        ...(requestedBy ? { requestedBy } : {}),
      },
    });
    invalidateDossiers();
    // 画面の createClipAction (clips/actions.ts の revalidateClips) と同じ範囲を捨てる
    revalidatePath("/clips");
    revalidatePath("/dossiers");
    revalidatePath(`/assets/${assetId}`);
    return NextResponse.json({ id: item.id, assetId, located: item.excerptStart != null }, { status: 201 });
  } catch (e) {
    // 派生 (NotFound / Forbidden) を親の ClipInputError より先に見る
    if (e instanceof ClipAssetNotFoundError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    if (e instanceof ClipForbiddenError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    if (e instanceof ClipInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
