import { describe, expect, it } from "vitest";

import { addCandidate, pickCandidate, type Candidate } from "./matching";

/** frontmatter 由来の日付 (UTC 深夜で保存される) */
const articleDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
/** Asset.canonicalDate の日付のみの値 (JST 深夜 = 15:00 UTC 前日で保存される) */
const assetDate = (s: string) => new Date(new Date(`${s}T00:00:00.000Z`).getTime() - 9 * 3600 * 1000);

describe("addCandidate", () => {
  it("同じ Asset を重複させない", () => {
    const m = new Map<string, Candidate[]>();
    addCandidate(m, "k", { id: "a", date: null });
    addCandidate(m, "k", { id: "a", date: null });
    addCandidate(m, "k", { id: "b", date: null });
    expect(m.get("k")?.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("pickCandidate", () => {
  it("候補が無ければ not_found", () => {
    expect(pickCandidate(undefined, null)).toEqual({ id: null, reason: "not_found" });
    expect(pickCandidate([], null)).toEqual({ id: null, reason: "not_found" });
  });

  it("候補が 1 件だけならそれを選ぶ", () => {
    expect(pickCandidate([{ id: "a", date: null }], null)).toEqual({ id: "a" });
  });

  it("候補が複数で日付の手がかりが無ければ ambiguous", () => {
    // Asset.title / SourceRecord.url に一意制約が無いので実際に起きる。
    // 後勝ちで選ぶと無関係な Asset に applied として紐づく
    const r = pickCandidate([{ id: "a", date: null }, { id: "b", date: null }], null);
    expect(r).toEqual({ id: null, reason: "ambiguous", candidates: 2 });
  });

  it("JST 基準で日付が一致する候補を選ぶ", () => {
    // Asset は JST 深夜 (15:00 UTC 前日)、記事は UTC 深夜。
    // 素の UTC 日付で比較すると常に 1 日ずれる
    const cands = [
      { id: "a", date: assetDate("2026-03-07") },
      { id: "b", date: assetDate("2026-03-20") },
    ];
    expect(pickCandidate(cands, articleDate("2026-03-07"))).toEqual({ id: "a" });
    expect(pickCandidate(cands, articleDate("2026-03-20"))).toEqual({ id: "b" });
  });

  it("JST 深夜の Asset を UTC 日付で取り違えない", () => {
    // 2025-12-25 JST の Asset は UTC では 2025-12-24T15:00Z。
    // UTC の日付で比べると 12-24 になり、記事の 12-25 と食い違う
    const cands = [{ id: "a", date: new Date("2025-12-24T15:00:00.000Z") }];
    expect(pickCandidate(cands, articleDate("2025-12-25"))).toEqual({ id: "a" });
  });

  it("strictDate なら、日付が食い違う唯一の候補を否認する", () => {
    // label 照合は手がかりが弱いので、同じラベルでも別の日の出来事なら別物とみなす。
    // --create-missing の再照合ループでもこれが効き、癖.md の ^[2] ^[3] のような
    // 「同一ラベル・日付違い」が同じ Asset に吸い込まれるのを防ぐ
    const cands = [{ id: "a", date: assetDate("2026-03-04") }];
    expect(pickCandidate(cands, articleDate("2026-03-14"), { strictDate: true })).toEqual({
      id: null,
      reason: "date_mismatch",
      candidates: 1,
    });
  });

  it("strictDate でなければ、日付が食い違っても唯一の候補を採る", () => {
    // url 照合は完全一致なので、日付を拒否権にすると正しい紐づけを永久に落とす
    // (frontmatter が放送日、Asset が配信日、のように正当にずれる実例がある)
    const cands = [{ id: "a", date: assetDate("2026-04-27") }];
    expect(pickCandidate(cands, articleDate("2026-05-24"))).toEqual({ id: "a" });
  });

  it("日付が一致する候補があれば、日付なし候補より優先する", () => {
    const cands = [
      { id: "undated", date: null },
      { id: "matched", date: assetDate("2026-03-14") },
    ];
    expect(pickCandidate(cands, articleDate("2026-03-14"))).toEqual({ id: "matched" });
  });

  it("日付で 1 件に絞れなければ ambiguous", () => {
    const cands = [
      { id: "a", date: assetDate("2026-03-07") },
      { id: "b", date: assetDate("2026-03-07") },
    ];
    expect(pickCandidate(cands, articleDate("2026-03-07"))).toEqual({
      id: null,
      reason: "ambiguous",
      candidates: 2,
    });
  });

  it("日付を持たない候補は日付で否定しない", () => {
    // canonicalDate が未設定なだけの Asset を「日付が違う」と切り捨てない
    const cands = [{ id: "a", date: null }];
    expect(pickCandidate(cands, articleDate("2026-03-14"))).toEqual({ id: "a" });
  });

  it("日付つきが一致せず、日付なしが 1 件あればそれを選ぶ", () => {
    const cands = [
      { id: "dated", date: assetDate("2026-03-04") },
      { id: "undated", date: null },
    ];
    expect(pickCandidate(cands, articleDate("2026-03-14"))).toEqual({ id: "undated" });
  });

  it("候補の日付がすべて未設定なら日付では絞らない", () => {
    const cands = [{ id: "a", date: null }, { id: "b", date: null }];
    expect(pickCandidate(cands, articleDate("2026-03-14"))).toEqual({
      id: null,
      reason: "ambiguous",
      candidates: 2,
    });
  });
});
