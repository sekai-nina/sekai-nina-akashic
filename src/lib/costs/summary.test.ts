import { describe, expect, it } from "vitest";

import {
  burnRatePerDay,
  daysRemaining,
  estimateBalance,
  fillMissingDays,
  jstDateOnlyToColumn,
  judgeCredit,
  CREDIT_ERROR_DAYS,
  CREDIT_WARN_DAYS,
  SNAPSHOT_STALE_DAYS,
} from "./summary";

describe("burnRatePerDay", () => {
  const today = "2026-09-19";

  it("記録のある日数で割る (当日は途中経過なので除く)", () => {
    const costs = [
      { date: "2026-09-17", usd: 1 },
      { date: "2026-09-18", usd: 3 },
      { date: today, usd: 99 },
    ];
    expect(burnRatePerDay(costs, today)).toBe(2);
  });

  it("使わなかった日が 0 として記録されていればそれも平均に入る", () => {
    const costs = [
      { date: "2026-09-16", usd: 0 },
      { date: "2026-09-17", usd: 0 },
      { date: "2026-09-18", usd: 7 },
    ];
    expect(burnRatePerDay(costs, today)).toBeCloseTo(7 / 3, 6);
  });

  it("窓の中だけを見る (窓の外の古い支出は効かない)", () => {
    const costs = [
      { date: "2026-09-11", usd: 100 }, // 窓の外 (today - 7 = 2026-09-12 より前)
      { date: "2026-09-13", usd: 7 },
      { date: "2026-09-15", usd: 7 },
    ];
    // 窓は 09-12〜09-18 の 7 日。14 / 7 = 2
    expect(burnRatePerDay(costs, today, 7)).toBe(2);
  });

  it("窓の中に記録が無ければ 0 (使っていない = 減っていない)", () => {
    const costs = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      usd: 100,
    }));
    expect(burnRatePerDay(costs, today, 7)).toBe(0);
  });

  it("記録が窓より新しいときは、その最初の日からの日数で割る (0 の日を捏造しない)", () => {
    // 昨日から使い始めた: 昨日 $5 → 1 日あたり $5 (7 で割って $0.71 にしない)
    expect(burnRatePerDay([{ date: "2026-09-18", usd: 5 }], today, 7)).toBe(5);
  });

  it("記録が無ければ 0", () => {
    expect(burnRatePerDay([], today)).toBe(0);
    expect(burnRatePerDay([{ date: today, usd: 5 }], today)).toBe(0);
  });
});

describe("estimateBalance / daysRemaining", () => {
  const snapshot = { balanceUsd: 25, observedAt: new Date("2026-09-10T00:00:00Z") };

  it("スナップショットから支出を引く", () => {
    expect(estimateBalance({ snapshot, spentSince: 4.5 })).toBe(20.5);
  });

  it("スナップショットが無ければ null", () => {
    expect(estimateBalance({ snapshot: null, spentSince: 10 })).toBeNull();
  });

  it("残り日数は切り捨て", () => {
    expect(daysRemaining(20, 3)).toBe(6);
    expect(daysRemaining(20, 0)).toBeNull();
    expect(daysRemaining(null, 3)).toBeNull();
    expect(daysRemaining(0, 3)).toBe(0);
    expect(daysRemaining(-5, 3)).toBe(0);
  });
});

describe("judgeCredit", () => {
  const base = { balanceUsd: 100, burnPerDay: 1, snapshotAgeDays: 1, days: 100 };

  it("残高未登録は unknown (障害ではない)", () => {
    expect(judgeCredit({ ...base, balanceUsd: null, snapshotAgeDays: null }).status).toBe("unknown");
  });

  it("古すぎるスナップショットは unknown", () => {
    expect(judgeCredit({ ...base, snapshotAgeDays: SNAPSHOT_STALE_DAYS + 1 }).status).toBe("unknown");
    expect(judgeCredit({ ...base, snapshotAgeDays: SNAPSHOT_STALE_DAYS }).status).toBe("ok");
  });

  it("残り日数の境界", () => {
    expect(judgeCredit({ ...base, days: CREDIT_WARN_DAYS }).status).toBe("ok");
    expect(judgeCredit({ ...base, days: CREDIT_WARN_DAYS - 1 }).status).toBe("warn");
    expect(judgeCredit({ ...base, days: CREDIT_ERROR_DAYS }).status).toBe("warn");
    expect(judgeCredit({ ...base, days: CREDIT_ERROR_DAYS - 1 }).status).toBe("error");
  });

  it("残高が尽きていれば error", () => {
    expect(judgeCredit({ ...base, balanceUsd: 0, days: 0 }).status).toBe("error");
  });

  it("消費が無ければ ok (残り日数は出せない)", () => {
    const r = judgeCredit({ ...base, burnPerDay: 0, days: null });
    expect(r.status).toBe("ok");
    expect(r.summary).toBe("直近の消費なし");
  });

  it("古すぎるスナップショットは残高 0 より先に判定される (入力待ちを異常と言わない)", () => {
    expect(judgeCredit({ balanceUsd: 0, burnPerDay: 1, snapshotAgeDays: SNAPSHOT_STALE_DAYS + 1, days: 0 }).status).toBe(
      "unknown",
    );
  });

  it("要約に金額を入れない (Discord に残高を流さない)", () => {
    for (const days of [3, 10, 100]) {
      expect(judgeCredit({ ...base, days }).summary).not.toMatch(/\$|\d+\.\d\d/);
    }
    expect(judgeCredit({ ...base, balanceUsd: 0, days: 0 }).summary).not.toContain("$");
  });
});

describe("fillMissingDays", () => {
  it("記録の無い日を 0 で埋めて日付順に並べる", () => {
    expect(fillMissingDays([{ date: "2026-09-17", usd: 3 }], "2026-09-15", "2026-09-18")).toEqual([
      { date: "2026-09-15", usd: 0 },
      { date: "2026-09-16", usd: 0 },
      { date: "2026-09-17", usd: 3 },
      { date: "2026-09-18", usd: 0 },
    ]);
  });

  it("範囲外の記録は捨てる", () => {
    expect(fillMissingDays([{ date: "2026-08-01", usd: 9 }], "2026-09-18", "2026-09-18")).toEqual([
      { date: "2026-09-18", usd: 0 },
    ]);
  });
});

describe("jstDateOnlyToColumn", () => {
  it("DATE 列の格納規約 (UTC 00:00) に直し、そのまま切り戻せる", () => {
    const d = jstDateOnlyToColumn("2026-09-19");
    expect(d.toISOString()).toBe("2026-09-19T00:00:00.000Z");
    expect(d.toISOString().slice(0, 10)).toBe("2026-09-19");
  });
});
