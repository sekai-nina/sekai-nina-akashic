import { NextResponse } from "next/server";
import { TiktokConflictError, TiktokNotFoundError, TiktokTargetError } from "@/lib/tiktok/targets";

/**
 * `/api/v1/tiktok/*` の route が共有する小物 (#179)。
 * ドメイン例外を HTTP に写す場所はここ 1 つにする。
 */

export type JsonBody = { ok: true; body: unknown } | { ok: false; response: NextResponse };

export async function readJsonBody(request: Request): Promise<JsonBody> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "invalid JSON body" }, { status: 400 }) };
  }
}

export function handleTiktokError(e: unknown): NextResponse {
  if (e instanceof TiktokNotFoundError) {
    return NextResponse.json({ error: e.message }, { status: 404 });
  }
  if (e instanceof TiktokConflictError) {
    return NextResponse.json({ error: e.message }, { status: 409 });
  }
  if (e instanceof TiktokTargetError) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  // Prisma の文言 (制約名・列名) を外に出さない
  console.error("tiktok api error:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
