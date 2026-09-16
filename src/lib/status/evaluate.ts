import type { Prisma, StatusCheckState } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runAllChecks, type CheckRun } from "./checks";
import { formatNotification, isDiscordConfigured, postDiscord, type NotificationLine } from "./discord";
import { pruneJobRuns } from "./jobs";
import { decideNotification } from "./judge";
import { EVALUATION_MIN_INTERVAL_SEC } from "./types";

/**
 * 全チェックを評価して StatusCheckState に保存し、変化があれば Discord に通知する。
 * cron (`GET /api/cron/status`) と /status の「今すぐ評価」の両方がこれを呼ぶ。
 */

export interface EvaluatedCheck {
  state: StatusCheckState;
  prevStatus: StatusCheckState["status"] | null;
}

export type EvaluationResult =
  | {
      skipped: false;
      evaluatedAt: Date;
      checks: EvaluatedCheck[];
      /** Discord に流した行 (未設定なら空) */
      notified: NotificationLine[];
      /** 通知しようとして失敗したときのメッセージ */
      notifyError: string | null;
      prunedRuns: number;
    }
  | {
      /** 直前に別の評価が走っていたので何もしなかった (cron と「今すぐ評価」の重なり) */
      skipped: true;
      lastEvaluatedAt: Date;
    };

/**
 * 1 回の評価。
 *
 * 1. 直近 `EVALUATION_MIN_INTERVAL_SEC` 以内に評価済みなら何もしない (二重通知の防止)
 * 2. 全チェックを走らせる (1 つの例外・タイムアウトは error として扱い、他は続ける)
 * 3. 前回の状態と比べて `since` を決め、upsert する。定義から消えたチェックの行は消す
 * 4. 通知対象を「最後に通知できた status」(`notifiedStatus`) との比較で集め、1 メッセージで送る。
 *    送れたものだけ `lastNotifiedAt` / `notifiedStatus` を進める (失敗したら次の評価で同じ遷移を
 *    もう一度送る)。通知の要らない行は `notifiedStatus` を今回の status に同期する
 * 5. 古い JobRun を消す
 */
export async function evaluateAllChecks(opts: { notify: boolean; now?: Date } = { notify: true }): Promise<EvaluationResult> {
  const now = opts.now ?? new Date();

  const latest = await prisma.statusCheckState.aggregate({ _max: { evaluatedAt: true } });
  const lastEvaluatedAt = latest._max.evaluatedAt;
  if (lastEvaluatedAt && now.getTime() - lastEvaluatedAt.getTime() < EVALUATION_MIN_INTERVAL_SEC * 1000) {
    return { skipped: true, lastEvaluatedAt };
  }

  const runs = await runAllChecks({ now });
  const previous = new Map((await prisma.statusCheckState.findMany()).map((s) => [s.key, s]));

  const checks: EvaluatedCheck[] = [];
  const pending: { line: NotificationLine; key: string }[] = [];

  for (const run of runs) {
    const prev = previous.get(run.def.key) ?? null;
    const kind = run.def.notify
      ? decideNotification({
          notifiedStatus: prev?.notifiedStatus ?? null,
          nextStatus: run.outcome.status,
          lastNotifiedAt: prev?.lastNotifiedAt ?? null,
          now,
        })
      : null;
    const state = await persist(run, prev, now, { syncNotified: kind == null });
    checks.push({ state, prevStatus: prev?.status ?? null });
    if (kind) {
      pending.push({
        key: run.def.key,
        line: {
          name: run.def.name,
          status: state.status,
          prevStatus: prev?.notifiedStatus ?? null,
          summary: state.summary,
          kind,
        },
      });
    }
  }

  // 定義から消えたチェック (DataSource を無効にした等) の行は残さない
  const liveKeys = new Set(runs.map((r) => r.def.key));
  const stale = [...previous.keys()].filter((k) => !liveKeys.has(k));
  if (stale.length) await prisma.statusCheckState.deleteMany({ where: { key: { in: stale } } });

  let notified: NotificationLine[] = [];
  let notifyError: string | null = null;
  if (opts.notify && pending.length && isDiscordConfigured()) {
    try {
      await postDiscord(formatNotification(pending.map((p) => p.line)));
      // 送れた行だけ「通知済み」を進める。status ごとに分けて更新する
      for (const p of pending) {
        await prisma.statusCheckState.update({
          where: { key: p.key },
          data: { lastNotifiedAt: now, notifiedStatus: p.line.status },
        });
      }
      notified = pending.map((p) => p.line);
    } catch (e) {
      notifyError = e instanceof Error ? e.message : String(e);
      console.error(`[status] Discord 通知に失敗 (${pending.length} 件は次回に持ち越し): ${notifyError}`);
    }
  }

  const prunedRuns = await pruneJobRuns(now);
  return { skipped: false, evaluatedAt: now, checks, notified, notifyError, prunedRuns };
}

async function persist(
  run: CheckRun,
  prev: StatusCheckState | null,
  now: Date,
  opts: { syncNotified: boolean },
): Promise<StatusCheckState> {
  const { status, summary } = run.outcome;
  const detail = (run.outcome.detail ?? {}) as Prisma.InputJsonObject;
  const since = prev && prev.status === status ? prev.since : now;
  // 名前・グループも写す。/status は保護テーブルを読まずにこの行だけで描く
  const meta = { group: run.def.group, name: run.def.name, description: run.def.description, notify: run.def.notify };
  // 通知の要らない遷移 (ok → ok、→ unknown、info チェック) は通知済み status を今の値に揃えておく。
  // そうしないと unknown を挟んで戻ったときに古い遷移として通知される
  const sync = opts.syncNotified ? { notifiedStatus: status } : {};
  return prisma.statusCheckState.upsert({
    where: { key: run.def.key },
    create: { key: run.def.key, ...meta, status, summary, detail, since, evaluatedAt: now, ...sync },
    update: { ...meta, status, summary, detail, since, evaluatedAt: now, ...sync },
  });
}
