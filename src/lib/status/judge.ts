import type { JobRunStatus, StatusLevel } from "@prisma/client";
import { formatRelative } from "@/lib/utils";
import {
  ALERT_CONFIRM_SEC,
  HEARTBEAT_STALE_FACTOR,
  HEARTBEAT_STALE_MIN_SEC,
  RENOTIFY_INTERVAL_HOURS,
  SUMMARY_MESSAGE_MAX_CHARS,
  type CheckOutcome,
} from "./types";

/**
 * 判定の純粋関数。DB を触る checks.ts / evaluate.ts から呼び、vitest で閾値の境界を固定する。
 */

/** 「最終登録が maxAgeHours 以内か」。無ければ warn (一度も登録が無い = 収集が始まっていない) */
export function judgeFreshness(lastAt: Date | null, maxAgeHours: number, now: Date): CheckOutcome {
  const detail = { lastAt: lastAt?.toISOString() ?? null, maxAgeHours };
  if (!lastAt) return { status: "warn", summary: "登録なし", detail };
  const ageHours = (now.getTime() - lastAt.getTime()) / 3_600_000;
  const rel = formatRelative(lastAt, now);
  if (ageHours > maxAgeHours) {
    return { status: "warn", summary: `最終登録 ${rel} (${maxAgeHours} 時間以上なし)`, detail };
  }
  return { status: "ok", summary: `最終登録 ${rel}`, detail };
}

export interface HeartbeatSnapshot {
  intervalSec: number | null;
  lastRunAt: Date | null;
  lastOkAt: Date | null;
  lastStatus: JobRunStatus | null;
  lastMessage: string;
}

/** 報告が途絶えたとみなす秒数。intervalSec × 3、ただし 15 分は待つ (cron の粒度と bot の再起動を吸収) */
export function heartbeatStaleAfterSec(intervalSec: number | null): number | null {
  if (intervalSec == null || intervalSec <= 0) return null;
  return Math.max(intervalSec * HEARTBEAT_STALE_FACTOR, HEARTBEAT_STALE_MIN_SEC);
}

/**
 * 失敗を error とみなすまでの猶予 (秒)。1 回の失敗で即 error にすると、60 秒 poll の bot が
 * 一時的に失敗するたびに ok ↔ error が往復して通知が 2 通ずつ出る。
 * 「1 周期 (下限 15 分) 成功が無い」まで待つ。間隔の申告が無ければ猶予なし
 */
export function heartbeatErrorAfterSec(intervalSec: number | null): number {
  if (intervalSec == null || intervalSec <= 0) return 0;
  return Math.max(intervalSec, HEARTBEAT_STALE_MIN_SEC);
}

/** bot の自由文を summary / Discord に載せるときの長さ制限 */
export function clipMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > SUMMARY_MESSAGE_MAX_CHARS ? `${oneLine.slice(0, SUMMARY_MESSAGE_MAX_CHARS)}…` : oneLine;
}

/**
 * ハートビートの判定。
 *   - 報告が一度も無い → unknown (期待ジョブの「未報告」)
 *   - 最後の報告が error で、成功が猶予 (`heartbeatErrorAfterSec`) を超えて無い → error (メッセージ付き)
 *   - 最終成功が staleAfter を超えて古い → error (報告が途絶えた)
 *   - それ以外 → ok。直近の報告が失敗でも猶予内なら ok に「直近の報告は失敗」を添える
 */
export function judgeHeartbeat(job: HeartbeatSnapshot | null, now: Date): CheckOutcome {
  if (!job || !job.lastRunAt) {
    return { status: "unknown", summary: "未報告", detail: {} };
  }
  const detail = {
    lastRunAt: job.lastRunAt.toISOString(),
    lastOkAt: job.lastOkAt?.toISOString() ?? null,
    lastStatus: job.lastStatus,
    lastMessage: job.lastMessage,
    intervalSec: job.intervalSec,
  };
  const sinceOk = job.lastOkAt ?? job.lastRunAt;
  const sinceOkSec = (now.getTime() - sinceOk.getTime()) / 1000;
  const message = clipMessage(job.lastMessage);

  if (job.lastStatus === "error") {
    const graceSec = heartbeatErrorAfterSec(job.intervalSec);
    // 一度も成功していない (lastOkAt が無い) なら猶予は見ない
    if (!job.lastOkAt || sinceOkSec > graceSec) {
      const msg = message ? `: ${message}` : "";
      return { status: "error", summary: `失敗 (${formatRelative(job.lastRunAt, now)})${msg}`, detail };
    }
  }

  const staleAfter = heartbeatStaleAfterSec(job.intervalSec);
  if (staleAfter != null && sinceOkSec > staleAfter) {
    return {
      status: "error",
      summary: `報告が途絶えています (最終成功 ${formatRelative(sinceOk, now)})`,
      detail,
    };
  }

  const base = `最終成功 ${formatRelative(sinceOk, now)}`;
  if (job.lastStatus === "error") {
    return { status: "ok", summary: `${base} (直近の報告は失敗${message ? `: ${message}` : ""})`, detail };
  }
  return { status: "ok", summary: base, detail };
}

const ALERT_LEVELS: ReadonlySet<StatusLevel> = new Set(["warn", "error"]);

export interface NotifyDecisionInput {
  /** 最後に通知できた (または通知不要で同期した) status。初回は null */
  notifiedStatus: StatusLevel | null;
  nextStatus: StatusLevel;
  /** 今の status になった時刻。非 ok の第一報はここから ALERT_CONFIRM_SEC 待って裏を取る */
  since: Date;
  lastNotifiedAt: Date | null;
  now: Date;
}

/**
 * Discord に流すかどうか。**前回の status ではなく「最後に通知できた status」と比べる**
 * (送信に失敗した回の遷移を次の評価で拾い直すため)。
 *   - ok / unknown → warn / error: 第一報。ただし **`since` から ALERT_CONFIRM_SEC 経つまで待つ**
 *     (= 2 回続けて同じ非 ok を観測してから。1 回きりの異常で通知が往復しないため)
 *   - warn ↔ error: 悪化・軽減も一報 (同じく確認してから)
 *   - warn / error → ok: 復旧。**待たずにすぐ出す** (通知済みの異常が消えたことは早く知りたい)
 *   - warn / error のまま 24h 経過: 放置防止のリマインド
 * 初回評価 (notifiedStatus が null) で warn / error なら確認後に第一報を出す。unknown への遷移は
 * 出さない (トークン未設定などの構成の話で、障害ではない)。
 */
export function decideNotification(input: NotifyDecisionInput): "transition" | "reminder" | null {
  const { notifiedStatus, nextStatus, since, lastNotifiedAt, now } = input;
  const nextAlert = ALERT_LEVELS.has(nextStatus);
  const prevAlert = notifiedStatus != null && ALERT_LEVELS.has(notifiedStatus);
  if (notifiedStatus !== nextStatus) {
    if (nextAlert) {
      const confirmedSec = (now.getTime() - since.getTime()) / 1000;
      return confirmedSec >= ALERT_CONFIRM_SEC ? "transition" : null;
    }
    if (prevAlert && nextStatus === "ok") return "transition";
    return null;
  }
  if (nextAlert) {
    const elapsedHours = lastNotifiedAt ? (now.getTime() - lastNotifiedAt.getTime()) / 3_600_000 : Infinity;
    if (elapsedHours >= RENOTIFY_INTERVAL_HOURS) return "reminder";
  }
  return null;
}

/** 件数の集計。cron の応答・Server Action の結果・/status のサマリーで共有 */
export function countByLevel(levels: Iterable<StatusLevel>): Record<StatusLevel, number> {
  const counts: Record<StatusLevel, number> = { ok: 0, warn: 0, error: 0, unknown: 0 };
  for (const l of levels) counts[l]++;
  return counts;
}
