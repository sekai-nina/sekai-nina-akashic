import type { Prisma, StatusCheckState } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runAllChecks } from "./checks";
import { formatNotification, isDiscordConfigured, postDiscord, type NotificationLine } from "./discord";
import { pruneJobRuns } from "./jobs";
import { clipMessage, decideNotification } from "./judge";
import { EVALUATION_MIN_INTERVAL_SEC, type CheckDefinition, type CheckOutcome } from "./types";

/**
 * 全チェックを評価して StatusCheckState に保存し、変化があれば Discord に通知する。
 * cron (`GET /api/cron/status`) と /status の「今すぐ評価」の両方がこれを呼ぶ。
 */

export interface EvaluatedCheck {
  state: StatusCheckState;
  prevStatus: StatusCheckState["status"] | null;
  /** 今回は測れず、前回の値を持ち越した */
  stale: boolean;
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
      /** 測れなかったチェックの key */
      failedKeys: string[];
      prunedRuns: number;
    }
  | {
      /** 直前に別の評価が走っていたので何もしなかった (cron と「今すぐ評価」の重なり) */
      skipped: true;
      lastEvaluatedAt: Date;
    };

/** 評価そのものの健全性を表す合成チェック (チェック定義ではなく評価の結果から作る) */
const EVALUATION_CHECK: Omit<CheckDefinition, "run"> = {
  key: "system.evaluation",
  group: "system",
  name: "評価そのもの",
  description: "各チェックを最後まで測れたか (測れなければ他のチェックは前回の値のまま)",
  notify: true,
};

/**
 * 1 回の評価。
 *
 * 1. 直近 `EVALUATION_MIN_INTERVAL_SEC` 以内に評価済みなら何もしない (二重通知の防止)
 * 2. 全チェックを直列で走らせる
 * 3. **測れなかったチェックは前回の状態をそのまま残す** (status も since も動かさない)。
 *    測れないことと壊れていることは別で、接続待ちや GitHub の 5xx で「異常」にしない。
 *    測れなかった事実は合成チェック `system.evaluation` に集約する
 * 4. 通知対象を「最後に通知できた status」との比較で集め、1 メッセージで送る。
 *    非 ok の第一報は `since` から確認時間が経つまで待つ (`decideNotification`)
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
  const failed: { def: CheckDefinition; failure: string }[] = [];

  const consider = async (
    def: Omit<CheckDefinition, "run">,
    outcome: CheckOutcome,
    opts2: { stale: boolean },
  ) => {
    const prev = previous.get(def.key) ?? null;
    const kind = def.notify
      ? decideNotification({
          notifiedStatus: prev?.notifiedStatus ?? null,
          nextStatus: outcome.status,
          since: prev && prev.status === outcome.status ? prev.since : now,
          lastNotifiedAt: prev?.lastNotifiedAt ?? null,
          now,
        })
      : null;
    const state = await persist(def, outcome, prev, now, { syncNotified: kind == null });
    checks.push({ state, prevStatus: prev?.status ?? null, stale: opts2.stale });
    if (kind) {
      pending.push({
        key: def.key,
        line: {
          name: def.name,
          status: state.status,
          prevStatus: prev?.notifiedStatus ?? null,
          summary: state.summary,
          kind,
        },
      });
    }
  };

  for (const run of runs) {
    if (run.outcome) {
      await consider(run.def, run.outcome, { stale: false });
      continue;
    }
    // 測れなかった: 前回の値を持ち越す (無ければ unknown)。since は動かさない
    failed.push({ def: run.def, failure: run.failure ?? "不明" });
    const prev = previous.get(run.def.key) ?? null;
    const carried: CheckOutcome = prev
      ? { status: prev.status, summary: prev.summary, detail: asObject(prev.detail) }
      : { status: "unknown", summary: "まだ測れていません", detail: {} };
    await consider(run.def, carried, { stale: true });
  }

  await consider(EVALUATION_CHECK, evaluationOutcome(failed), { stale: false });

  // 定義から消えたチェック (DataSource を無効にした等) の行は残さない
  const liveKeys = new Set([...runs.map((r) => r.def.key), EVALUATION_CHECK.key]);
  const stale = [...previous.keys()].filter((k) => !liveKeys.has(k));
  if (stale.length) await prisma.statusCheckState.deleteMany({ where: { key: { in: stale } } });

  let notified: NotificationLine[] = [];
  let notifyError: string | null = null;
  if (opts.notify && pending.length && isDiscordConfigured()) {
    try {
      await postDiscord(formatNotification(pending.map((p) => p.line)));
      // 送れた行だけ「通知済み」を進める
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
  return {
    skipped: false,
    evaluatedAt: now,
    checks,
    notified,
    notifyError,
    failedKeys: failed.map((f) => f.def.key),
    prunedRuns,
  };
}

/**
 * 測れなかったチェックの集約。1 回だけなら ok のまま (通知の確認時間で 2 回続いたときだけ
 * 通知される)。理由は最初の 1 件だけ載せる (同じ原因で並ぶため)。
 */
function evaluationOutcome(failed: { def: CheckDefinition; failure: string }[]): CheckOutcome {
  if (failed.length === 0) return { status: "ok", summary: "全チェックを評価できた", detail: { failed: [] } };
  const detail = {
    failed: failed.map((f) => ({ key: f.def.key, name: f.def.name, reason: clipMessage(f.failure) })),
  };
  return {
    status: "warn",
    summary: `${failed.length} 件を測れず前回の値のまま: ${clipMessage(failed[0].failure)}`,
    detail,
  };
}

function asObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function persist(
  def: Omit<CheckDefinition, "run">,
  outcome: CheckOutcome,
  prev: StatusCheckState | null,
  now: Date,
  opts: { syncNotified: boolean },
): Promise<StatusCheckState> {
  const { status, summary } = outcome;
  const detail = (outcome.detail ?? {}) as Prisma.InputJsonObject;
  const since = prev && prev.status === status ? prev.since : now;
  // 名前・グループも写す。/status は保護テーブルを読まずにこの行だけで描く
  const meta = { group: def.group, name: def.name, description: def.description, notify: def.notify };
  // 通知の要らない遷移 (ok → ok、→ unknown、info チェック、確認待ち) は通知済み status を
  // 今の値に揃えておく。**確認待ち (非 ok になった直後) は揃えない** — 揃えると 2 回目の
  // 評価で「変化なし」と見なされ、第一報が永久に出なくなる
  const sync = opts.syncNotified && !isAlert(status) ? { notifiedStatus: status } : {};
  return prisma.statusCheckState.upsert({
    where: { key: def.key },
    create: { key: def.key, ...meta, status, summary, detail, since, evaluatedAt: now, ...sync },
    update: { ...meta, status, summary, detail, since, evaluatedAt: now, ...sync },
  });
}

function isAlert(status: StatusCheckState["status"]): boolean {
  return status === "warn" || status === "error";
}
