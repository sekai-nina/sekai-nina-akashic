import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { canFaceWorkerReportJob, FACE_WORKER_JOB_PREFIX, FACE_WORKER_PERMISSION } from "@/lib/faces/policy";
import { JOB_KEY_PATTERN, JobRunRequestSchema, recordJobRun } from "@/lib/status/jobs";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ key: string }> };

/**
 * ハートビート。bot / ワーカーの各ジョブが 1 サイクルごとに結果を報告する。
 *
 * Job は初回の報告で自動作成される。`intervalSec` を申告すると /status が
 * 「その 3 倍の時間、成功が無い」を途絶として検知する。
 * 監査ログには残さない (60 秒 poll のジョブが 1 日 1,440 行を書くため)。
 *
 * 顔認識の推論ワーカー (#389) は `face_worker` だけのキーで叩く。そのキーで送れるのは
 * `omokage.` で始まるジョブだけ (他の bot のジョブを偽れないように)。
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, ["write", FACE_WORKER_PERMISSION]);
  if (auth instanceof NextResponse) return auth;

  const { key } = await params;
  if (!JOB_KEY_PATTERN.test(key)) {
    return NextResponse.json({ error: "key must match ^[a-z0-9][a-z0-9_.-]{0,63}$" }, { status: 400 });
  }
  if (!auth.permissions.includes("write") && !canFaceWorkerReportJob(key)) {
    return NextResponse.json(
      { error: `face_worker のキーで送れるのは ${FACE_WORKER_JOB_PREFIX} で始まるジョブだけです` },
      { status: 403 }
    );
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = JobRunRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const result = await recordJobRun(key, parsed.data);
  return NextResponse.json({
    job: {
      key: result.job.key,
      name: result.job.name,
      intervalSec: result.job.intervalSec,
      lastRunAt: result.job.lastRunAt.toISOString(),
      lastOkAt: result.job.lastOkAt?.toISOString() ?? null,
      lastStatus: result.job.lastStatus,
    },
    recorded: result.recorded,
  });
}
