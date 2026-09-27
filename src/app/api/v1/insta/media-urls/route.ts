import { NextResponse, after } from "next/server";
import { z } from "zod";
import {
  completeStoryJob,
  getCurrentWorkerJob,
  noteStoryJobError,
  notifyStoryJobCompleted,
  registerStoryMediaUrls,
} from "@/lib/domain/insta-jobs";
import { instaJobErrorResponse, instaJobToJson, requireInstaJobAuth } from "@/lib/insta/api";
import { MAX_MEDIA_URLS, extractMediaUrls } from "@/lib/insta/jobs";
import { formatZodError } from "@/lib/zod-error";

// CDN からの取得 + Drive へのアップロード + サムネイル生成を URL の本数ぶん行う
export const maxDuration = 300;

/**
 * `jobId` を **知らない**呼び出し元のための口 (#198)。
 *
 * 「Instagram Download」は URL しか受け取らないので、その中に仕込む POST は jobId を持てない。
 * また Shortcuts の「ショートカットを実行」は入れ子や自己再入で出力が呼び出し元に戻らないことがあり、
 * 「URL を返してもらう」作りは実機で成立しなかった (2026-09-27〜28 実測: 出力点を 4 箇所に置き、
 * 自己呼び出し直後の exit も出力に変えたが、常に空だった)。
 *
 * そこで **内側の Shortcut が自分でここに POST する**。iPad は 1 台で同時に 1 件しか走らないので、
 * 「いま processing のジョブ」で宛先は一意に決まる。
 *
 * 1 件でも登録できたら **そのままジョブを完了にする** (#199)。ラッパーの `complete` が内側の POST より
 * 先に走ると 0 件で failed になってしまうため、完了の判断をこちらに寄せる
 * (ラッパーは start → Run Shortcut → Pushcut に戻る、だけでよくなる)。
 */
const Body = z
  .object({
    urls: z.array(z.string().max(2000)).max(MAX_MEDIA_URLS).optional(),
    text: z.string().max(100_000).optional(),
    /** どの仕込み位置から来たか (実機でどこが通るかを知るため)。人が読むだけ */
    mark: z.string().max(40).optional(),
  })
  .strict();

export async function POST(request: Request) {
  const auth = await requireInstaJobAuth(request, "worker");
  if (auth instanceof NextResponse) return auth;

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

  const job = await getCurrentWorkerJob(auth.clearance);
  if (!job) {
    return NextResponse.json({ error: "処理中のジョブがありません" }, { status: 409 });
  }

  const fromText = parsed.data.text ? extractMediaUrls(parsed.data.text) : [];
  const urls = [...new Set([...(parsed.data.urls ?? []).map((u) => u.trim()).filter(Boolean), ...fromText])];
  const mark = parsed.data.mark ? ` mark=${parsed.data.mark}` : "";
  if (urls.length === 0) {
    // **何が届いたかをジョブに残す。** 端末を覗かずに原因を追えるようにする
    const received = JSON.stringify(raw).slice(0, 300);
    await noteStoryJobError(job.id, `media-urls${mark} に URL が 1 件も入っていませんでした: ${received}`).catch(
      () => {},
    );
    return NextResponse.json({ error: "URL が 1 件もありません", jobId: job.id, received }, { status: 400 });
  }

  // 届いたことを残す (成功しても「どの位置から何件来たか」が後から分かるように)
  await noteStoryJobError(job.id, `media-urls${mark} に ${urls.length} 件届きました`).catch(() => {});
  try {
    const res = await registerStoryMediaUrls(job.id, urls, { id: auth.id, clearance: auth.clearance });
    if (res.files.length === 0) {
      return NextResponse.json(
        { ...instaJobToJson(res.job), registered: 0, files: [], failed: res.failed },
        { status: 207 },
      );
    }
    // 1 件でも入ったら完了にする (Discord と次のジョブの送信もここから。完了は冪等)
    const done = await completeStoryJob(job.id, auth.clearance);
    if (done.shouldNotify) {
      after(async () => {
        const r = await notifyStoryJobCompleted(done.job);
        console.log(
          `insta job ${done.job.id}: Discord notified=${r.notified} attached=${r.attached}${r.error ? ` error=${r.error}` : ""}`,
        );
      });
    }
    return NextResponse.json(
      {
        ...instaJobToJson(done.job),
        registered: res.files.length,
        files: res.files,
        failed: res.failed,
        notifyScheduled: done.shouldNotify,
        nextDispatchedId: done.next.dispatchedId,
      },
      { status: 201 },
    );
  } catch (e) {
    return instaJobErrorResponse(e);
  }
}
