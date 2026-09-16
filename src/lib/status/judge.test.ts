import { describe, expect, it } from "vitest";

import { formatRelative } from "@/lib/utils";
import { formatNotification } from "./discord";
import {
  clipMessage,
  countByLevel,
  decideNotification,
  heartbeatErrorAfterSec,
  heartbeatStaleAfterSec,
  judgeFreshness,
  judgeHeartbeat,
} from "./judge";

const now = new Date("2026-09-17T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const secAgo = (s: number) => new Date(now.getTime() - s * 1000);

describe("formatRelative", () => {
  it("60 秒未満は「たった今」、未来 (時計のずれ) も同じ", () => {
    expect(formatRelative(secAgo(59), now)).toBe("たった今");
    expect(formatRelative(secAgo(-30), now)).toBe("たった今");
  });

  it("分・時間・日の境界", () => {
    expect(formatRelative(secAgo(60), now)).toBe("1 分前");
    expect(formatRelative(secAgo(59 * 60), now)).toBe("59 分前");
    expect(formatRelative(hoursAgo(1), now)).toBe("1 時間前");
    expect(formatRelative(hoursAgo(47), now)).toBe("47 時間前");
    expect(formatRelative(hoursAgo(48), now)).toBe("2 日前");
  });

  it("null / 不正な日付は空文字", () => {
    expect(formatRelative(null, now)).toBe("");
    expect(formatRelative("not a date", now)).toBe("");
  });
});

describe("judgeFreshness", () => {
  it("閾値以内なら ok", () => {
    const r = judgeFreshness(hoursAgo(10), 72, now);
    expect(r.status).toBe("ok");
    expect(r.summary).toBe("最終登録 10 時間前");
  });

  it("閾値ちょうどは ok、超えたら warn (閾値を要約に出す)", () => {
    expect(judgeFreshness(hoursAgo(72), 72, now).status).toBe("ok");
    const r = judgeFreshness(hoursAgo(72.01), 72, now);
    expect(r.status).toBe("warn");
    expect(r.summary).toBe("最終登録 3 日前 (72 時間以上なし)");
  });

  it("登録が一度も無ければ warn", () => {
    const r = judgeFreshness(null, 72, now);
    expect(r.status).toBe("warn");
    expect(r.summary).toBe("登録なし");
  });

  it("detail に最終時刻と閾値を残す", () => {
    expect(judgeFreshness(hoursAgo(1), 48, now).detail).toEqual({
      lastAt: hoursAgo(1).toISOString(),
      maxAgeHours: 48,
    });
  });
});

describe("heartbeatStaleAfterSec / heartbeatErrorAfterSec", () => {
  it("途絶は intervalSec × 3、ただし 15 分は待つ", () => {
    expect(heartbeatStaleAfterSec(60)).toBe(15 * 60);
    expect(heartbeatStaleAfterSec(900)).toBe(2700);
    expect(heartbeatStaleAfterSec(21600)).toBe(64800);
  });

  it("失敗の猶予は intervalSec × 1、ただし 15 分は待つ。申告が無ければ猶予なし", () => {
    expect(heartbeatErrorAfterSec(60)).toBe(15 * 60);
    expect(heartbeatErrorAfterSec(3600)).toBe(3600);
    expect(heartbeatErrorAfterSec(null)).toBe(0);
  });

  it("間隔の申告が無ければ途絶は判定しない", () => {
    expect(heartbeatStaleAfterSec(null)).toBeNull();
    expect(heartbeatStaleAfterSec(0)).toBeNull();
  });
});

describe("clipMessage", () => {
  it("改行をつぶして 200 字で切る", () => {
    expect(clipMessage("a\n\n  b")).toBe("a b");
    const long = "x".repeat(250);
    expect(clipMessage(long)).toBe(`${"x".repeat(200)}…`);
  });
});

describe("judgeHeartbeat", () => {
  const base = { intervalSec: 60, lastRunAt: secAgo(30), lastOkAt: secAgo(30), lastStatus: "ok" as const, lastMessage: "" };

  it("報告が無ければ unknown (未報告)", () => {
    expect(judgeHeartbeat(null, now)).toEqual({ status: "unknown", summary: "未報告", detail: {} });
    expect(judgeHeartbeat({ ...base, lastRunAt: null }, now).status).toBe("unknown");
  });

  it("失敗が猶予内 (直近に成功あり) なら ok のまま「直近の報告は失敗」を添える", () => {
    const r = judgeHeartbeat({ ...base, lastStatus: "error", lastMessage: "timeout", lastOkAt: secAgo(120) }, now);
    expect(r.status).toBe("ok");
    expect(r.summary).toBe("最終成功 2 分前 (直近の報告は失敗: timeout)");
  });

  it("失敗が続いて 1 周期 (下限 15 分) 成功が無ければ error", () => {
    const r = judgeHeartbeat({ ...base, lastStatus: "error", lastMessage: "timeout", lastOkAt: secAgo(16 * 60) }, now);
    expect(r.status).toBe("error");
    expect(r.summary).toBe("失敗 (たった今): timeout");
  });

  it("一度も成功していない失敗は即 error", () => {
    expect(judgeHeartbeat({ ...base, lastStatus: "error", lastOkAt: null }, now).status).toBe("error");
  });

  it("間隔の申告が無い失敗は即 error", () => {
    expect(judgeHeartbeat({ ...base, intervalSec: null, lastStatus: "error" }, now).status).toBe("error");
  });

  it("成功が途絶えたら error (60 秒 poll は 15 分で途絶)", () => {
    expect(judgeHeartbeat({ ...base, lastRunAt: secAgo(14 * 60), lastOkAt: secAgo(14 * 60) }, now).status).toBe("ok");
    const r = judgeHeartbeat({ ...base, lastRunAt: secAgo(16 * 60), lastOkAt: secAgo(16 * 60) }, now);
    expect(r.status).toBe("error");
    expect(r.summary).toBe("報告が途絶えています (最終成功 16 分前)");
  });

  it("error のあとに成功が来れば ok に戻る", () => {
    const r = judgeHeartbeat({ ...base, lastStatus: "ok", lastRunAt: secAgo(10), lastOkAt: secAgo(10) }, now);
    expect(r).toMatchObject({ status: "ok", summary: "最終成功 たった今" });
  });

  it("間隔の申告が無ければ古くても ok", () => {
    expect(judgeHeartbeat({ ...base, intervalSec: null, lastRunAt: hoursAgo(100), lastOkAt: hoursAgo(100) }, now).status).toBe("ok");
  });

  it("2000 字のメッセージは要約では 200 字に切る", () => {
    const r = judgeHeartbeat({ ...base, lastStatus: "error", lastOkAt: null, lastMessage: "y".repeat(2000) }, now);
    expect(r.summary.length).toBeLessThan(260);
    expect(r.detail?.lastMessage).toHaveLength(2000);
  });
});

describe("decideNotification", () => {
  it("ok → warn / error は第一報", () => {
    expect(decideNotification({ notifiedStatus: "ok", nextStatus: "warn", lastNotifiedAt: null, now })).toBe("transition");
    expect(decideNotification({ notifiedStatus: "ok", nextStatus: "error", lastNotifiedAt: null, now })).toBe("transition");
  });

  it("初回評価 (通知済み無し) で warn / error も第一報、ok は出さない", () => {
    expect(decideNotification({ notifiedStatus: null, nextStatus: "error", lastNotifiedAt: null, now })).toBe("transition");
    expect(decideNotification({ notifiedStatus: null, nextStatus: "ok", lastNotifiedAt: null, now })).toBeNull();
  });

  it("warn ↔ error も一報", () => {
    expect(decideNotification({ notifiedStatus: "warn", nextStatus: "error", lastNotifiedAt: hoursAgo(1), now })).toBe("transition");
    expect(decideNotification({ notifiedStatus: "error", nextStatus: "warn", lastNotifiedAt: hoursAgo(1), now })).toBe("transition");
  });

  it("warn / error → ok は復旧の一報。unknown → ok は出さない", () => {
    expect(decideNotification({ notifiedStatus: "error", nextStatus: "ok", lastNotifiedAt: hoursAgo(1), now })).toBe("transition");
    expect(decideNotification({ notifiedStatus: "unknown", nextStatus: "ok", lastNotifiedAt: null, now })).toBeNull();
  });

  it("unknown への遷移は出さない (構成の話で障害ではない)", () => {
    expect(decideNotification({ notifiedStatus: "ok", nextStatus: "unknown", lastNotifiedAt: null, now })).toBeNull();
    expect(decideNotification({ notifiedStatus: "error", nextStatus: "unknown", lastNotifiedAt: hoursAgo(1), now })).toBeNull();
  });

  it("非 ok が続くときは 24h ごとにリマインド", () => {
    expect(decideNotification({ notifiedStatus: "warn", nextStatus: "warn", lastNotifiedAt: hoursAgo(23), now })).toBeNull();
    expect(decideNotification({ notifiedStatus: "warn", nextStatus: "warn", lastNotifiedAt: hoursAgo(24), now })).toBe("reminder");
    // 第一報が送れていない (lastNotifiedAt 無し) ならすぐ出す
    expect(decideNotification({ notifiedStatus: "error", nextStatus: "error", lastNotifiedAt: null, now })).toBe("reminder");
  });

  it("送信に失敗した遷移は notifiedStatus が進まないので、次の評価でも同じ遷移として出る", () => {
    // error → ok の復旧を送れなかった: 通知済みは error のまま、今回も ok → まだ「復旧」を出す
    expect(decideNotification({ notifiedStatus: "error", nextStatus: "ok", lastNotifiedAt: hoursAgo(2), now })).toBe("transition");
  });

  it("ok のままなら何も出さない", () => {
    expect(decideNotification({ notifiedStatus: "ok", nextStatus: "ok", lastNotifiedAt: null, now })).toBeNull();
  });
});

describe("countByLevel", () => {
  it("4 段階すべてのキーを持つ", () => {
    expect(countByLevel(["ok", "ok", "warn"])).toEqual({ ok: 2, warn: 1, error: 0, unknown: 0 });
  });
});

describe("formatNotification", () => {
  it("遷移・復旧・リマインドの 3 形と末尾のリンク", () => {
    const text = formatNotification([
      { name: "公式ブログ", status: "warn", prevStatus: "ok", summary: "最終登録 3 日前", kind: "transition" },
      { name: "bot: ブログ監視", status: "ok", prevStatus: "error", summary: "最終成功 1 分前", kind: "transition" },
      { name: "GitHub との差", status: "warn", prevStatus: "warn", summary: "3 本", kind: "reminder" },
      { name: "初回", status: "error", prevStatus: null, summary: "失敗", kind: "transition" },
    ], "/status");
    expect(text.split("\n")).toEqual([
      "🟠 **公式ブログ** — 正常 → 注意",
      "　最終登録 3 日前",
      "🟢 **bot: ブログ監視** — 異常 → 正常",
      "　最終成功 1 分前",
      "🟠 **GitHub との差** — 注意 が続いています",
      "　3 本",
      "🔴 **初回** — 異常",
      "　失敗",
      "/status",
    ]);
  });

  it("2000 字を超えるときは行単位で切り、リンクは残す", () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({
      name: `check ${i}`,
      status: "error" as const,
      prevStatus: "ok" as const,
      summary: "x".repeat(80),
      kind: "transition" as const,
    }));
    const text = formatNotification(lines, "/status");
    expect(text.length).toBeLessThanOrEqual(1900);
    expect(text.endsWith("\n/status")).toBe(true);
    expect(text).toMatch(/…他 \d+ 件/);
  });
});
