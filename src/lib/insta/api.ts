import { NextResponse } from "next/server";
import { requireApiAuth, type ApiKeyUser } from "@/lib/api-auth";
import { InstaJobError, WORKER_PERMISSION } from "@/lib/insta/jobs";
import type { InstaStoryJobView } from "@/lib/domain/insta-jobs";

/**
 * `/api/v1/insta/jobs/*` の入口 (#178)。
 *
 * iPad ワーカーのキーは `insta_worker` だけを持ち、read / write は持たない
 * (iPad が漏れても他の API は叩けない)。逆に write を持つ通常のキーからも同じ口を
 * 叩けるようにして、curl での動作確認や bot からの再送を可能にする。
 *
 * | mode | 通す permission |
 * |---|---|
 * | `list` (一覧) | `read` (ワーカーは自分のジョブ ID を Pushcut から受け取るので一覧は要らない) |
 * | `read` (詳細) | `read` または `insta_worker` |
 * | `create` (ジョブ作成) | `write` |
 * | `worker` (start / upload-url / result / complete / error) | `insta_worker` または `write` |
 */
export type InstaJobAuthMode = "list" | "read" | "create" | "worker";

const ALLOWED: Record<InstaJobAuthMode, readonly string[]> = {
  list: ["read"],
  read: ["read", WORKER_PERMISSION],
  create: ["write"],
  worker: [WORKER_PERMISSION, "write"],
};

export function requireInstaJobAuth(request: Request, mode: InstaJobAuthMode): Promise<ApiKeyUser | NextResponse> {
  return requireApiAuth(request, ALLOWED[mode]);
}

/** ドメイン層の例外を HTTP に写す。想定外はログに残して 500 */
export function instaJobErrorResponse(e: unknown): NextResponse {
  if (e instanceof InstaJobError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  console.error("insta job:", e);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

/** API の応答に載せる形。日時は ISO 8601 */
export function instaJobToJson(job: InstaStoryJobView) {
  return {
    id: job.id,
    handle: job.handle,
    url: job.url,
    status: job.status,
    result: job.result,
    error: job.error || null,
    createdAt: job.createdAt.toISOString(),
    dispatchedAt: job.dispatchedAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}
