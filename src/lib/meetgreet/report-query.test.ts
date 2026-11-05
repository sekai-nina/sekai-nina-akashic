import { describe, expect, it } from "vitest";
import {
  formatReportGroups,
  parseReportGroups,
  previewReportQuery,
  ReportSearchSchema,
  storedGroups,
} from "./report-query";

describe("parseReportGroups", () => {
  it("行の中は AND、行どうしは別のグループ", () => {
    expect(parseReportGroups("#坂井新奈 #ミーグリ\n#にぃぐり")).toEqual({
      ok: true,
      groups: [
        { tags: ["坂井新奈", "ミーグリ"], op: "and" },
        { tags: ["にぃぐり"], op: "and" },
      ],
    });
  });

  it("OR を挟むと OR のグループになる", () => {
    expect(parseReportGroups("#A OR #B OR C")).toEqual({
      ok: true,
      groups: [{ tags: ["A", "B", "C"], op: "or" }],
    });
  });

  it("全角の空白と全角の # を受ける。空行は無視する", () => {
    expect(parseReportGroups("＃坂井新奈　#ミーグリ\n\n  \n")).toEqual({
      ok: true,
      groups: [{ tags: ["坂井新奈", "ミーグリ"], op: "and" }],
    });
  });

  it("AND と OR を混ぜた行は断る", () => {
    expect(parseReportGroups("#A #B OR #C").ok).toBe(false);
  });

  it("OR で終わる行・# だけのタグは断る", () => {
    expect(parseReportGroups("#A OR").ok).toBe(false);
    expect(parseReportGroups("# #B").ok).toBe(false);
  });
});

describe("formatReportGroups", () => {
  it("parse と往復する", () => {
    const groups = [
      { tags: ["坂井新奈", "ミーグリ"], op: "and" as const },
      { tags: ["A", "B"], op: "or" as const },
    ];
    expect(parseReportGroups(formatReportGroups(groups))).toEqual({ ok: true, groups });
  });
});

describe("storedGroups", () => {
  it("形が崩れた Json は空にする", () => {
    expect(storedGroups({ tags: [] })).toEqual([]);
    expect(storedGroups(null)).toEqual([]);
  });
});

describe("previewReportQuery", () => {
  const options = { excludeRetweets: true, langJa: true };

  it("手で作った収集と同じクエリになる", () => {
    const parsed = parseReportGroups("#坂井新奈 #ミーグリ\n#坂井新奈 #ミーグリレポ\n#にぃぐり");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(previewReportQuery(parsed.groups, "", options)).toBe(
      "((#坂井新奈 #ミーグリ) OR (#坂井新奈 #ミーグリレポ) OR #にぃぐり) lang:ja -is:retweet"
    );
  });

  it("条件が空なら null", () => {
    expect(previewReportQuery([], " ", options)).toBeNull();
  });
});

describe("ReportSearchSchema", () => {
  it("タグも追加条件も空なら断る", () => {
    expect(ReportSearchSchema.safeParse({ groups: [], extra: " " }).success).toBe(false);
  });

  it("追加条件だけでも通す", () => {
    expect(ReportSearchSchema.safeParse({ groups: [], extra: "坂井新奈 ミーグリ" }).success).toBe(true);
  });
});
