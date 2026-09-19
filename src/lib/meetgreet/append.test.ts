import { describe, expect, it } from "vitest";

import { appendDiff, isPureAppend, planAppend, talkSortKeyFromLine, tiktokVideoId } from "./append";
import type { ArticleParts, RenderedSource } from "./article";

const EMPTY_PARTS: ArticleParts = {
  quotes: [],
  reports: [],
  tiktoks: [],
  talks: [],
  blogImages: [],
};

const BODY = [
  "<img src=\"https://r2.example/sketch.png\" alt=\"2026年8月1日 リアルミート＆グリート サムネイル\" width=\"600\">",
  "",
  "2026年8月1日、リアルミート＆グリートが開催された。",
  "",
  "## ファンによるミーグリレポ",
  "",
  "ファンが投稿したミート＆グリートの感想（X）。",
  "",
  "![rep](https://x.com/aaa/status/111)",
  "![](https://x.com/bbb/status/222)",
  "",
  "## 関連メディア",
  "",
  "### トーク",
  "",
  "- 【トーク・画像】坂井新奈トーク 2026.8.2 13:15^[3]",
  "- 【トーク・画像】坂井新奈トーク 2026.8.2 16:24^[4]",
  "",
].join("\n");

const plan = (parts: Partial<ArticleParts>, sources: RenderedSource[] = [], existingSources = []) =>
  planAppend({
    existingBody: BODY,
    parts: { ...EMPTY_PARTS, ...parts },
    sources,
    existingSources,
  });

describe("planAppend", () => {
  it("増えるものが無ければ本文を変えない", () => {
    const p = plan({ reports: ["https://x.com/bbb/status/222"] });
    expect(p.empty).toBe(true);
    expect(p.body).toBe(BODY.replace(/\n+$/, "") + "\n");
  });

  it("手で付けた ![rep] マーカーの行も「既にある」と見なす", () => {
    // ![rep] を剥がして比較しないと、同じレポを毎回足してしまう
    const p = plan({ reports: ["https://x.com/aaa/status/111"] });
    expect(p.added.reports).toBe(0);
  });

  it("クエリや twitter.com 表記の揺れを吸収する", () => {
    const p = plan({ reports: ["https://twitter.com/bbb/status/222?s=20"] });
    expect(p.added.reports).toBe(0);
  });

  it("新しいレポはレポ節の末尾に足す", () => {
    const p = plan({ reports: ["https://x.com/ccc/status/333"] });
    expect(p.added.reports).toBe(1);
    const lines = p.body.split("\n");
    const at = lines.indexOf("![](https://x.com/ccc/status/333)");
    expect(lines[at - 1]).toBe("![](https://x.com/bbb/status/222)");
    expect(isPureAppend(BODY, p.body)).toBe(true);
  });

  it("トークは時系列の正しい位置に差し込む", () => {
    const p = plan({
      talks: [
        { assetId: "x", line: "- 【トーク・画像】坂井新奈トーク 2026.8.2 13:49^[9]", sortAt: null },
      ],
    });
    const lines = p.body.split("\n");
    const at = lines.findIndex((l) => l.includes("13:49"));
    // 13:15 の後ろ、16:24 の前
    expect(lines[at - 1]).toContain("13:15");
    expect(lines[at + 1]).toContain("16:24");
  });

  it("既にあるトークは足さない (脚注番号が違っても中身で判定する)", () => {
    const p = plan({
      talks: [
        { assetId: "x", line: "- 【トーク・画像】坂井新奈トーク 2026.8.2 13:15^[99]", sortAt: null },
      ],
    });
    expect(p.added.talks).toBe(0);
  });

  it("題が既存行の前方一致でも、別の画像なら足す", () => {
    // 画像 1 枚だけのブログは題に (n/m) が付かない。部分一致で判定すると
    // 「…「待ち合わせ」」が「…「待ち合わせ」 (1/11)」に前方一致して取りこぼす
    const body = ['- 【ブログ・画像】坂井新奈ブログ「待ち合わせ」 (1/11)^[1]', ""].join("\n");
    const p = planAppend({
      existingBody: body,
      parts: {
        ...EMPTY_PARTS,
        blogImages: [{ assetId: "solo", line: "- 【ブログ・画像】坂井新奈ブログ「待ち合わせ」^[1]" }],
      },
      sources: [],
      existingSources: [],
    });
    expect(p.added.blogImages).toBe(1);
  });

  it("同じ行は脚注番号が違っても足さない", () => {
    const body = ['- 【ブログ・画像】坂井新奈ブログ「待ち合わせ」 (1/11)^[1]', ""].join("\n");
    const p = planAppend({
      existingBody: body,
      parts: {
        ...EMPTY_PARTS,
        blogImages: [{ assetId: "x", line: "- 【ブログ・画像】坂井新奈ブログ「待ち合わせ」 (1/11)^[9]" }],
      },
      sources: [],
      existingSources: [],
    });
    expect(p.added.blogImages).toBe(0);
  });

  it("出典 URL の突き合わせはフラグメントを保つ (ひなたぼっこ日記)", () => {
    // …/manager/list?ima=0000#article-NNNNN は #article-NNNNN だけが識別子。
    // クエリごと切ると別の投稿が同じ出典に化ける
    const base = "https://www.hinatazaka46.com/s/official/diary/manager/list?ima=0000";
    const p = planAppend({
      existingBody: "本文\n",
      parts: EMPTY_PARTS,
      sources: [
        { sourceNo: 1, label: "別の投稿", url: `${base}#article-70600`, date: null, assetId: "a2" },
      ],
      existingSources: [{ sourceNo: 3, assetId: "a1", url: `${base}#article-70538` }],
    });
    // 別 URL なので新しい出典として採番される (既存の 3 番に吸われない)
    expect(p.newSources).toHaveLength(1);
    expect(p.newSources[0].sourceNo).toBe(4);
  });

  it("出典は末尾に採番し、既存の番号は振り直さない", () => {
    const sources: RenderedSource[] = [
      { sourceNo: 1, label: "既にあるブログ", url: "https://blog.example/1", date: "2026-08-03", assetId: "a1" },
      { sourceNo: 2, label: "新しいトーク", url: null, date: "2026-08-04", assetId: "a2" },
    ];
    const p = planAppend({
      existingBody: BODY,
      parts: EMPTY_PARTS,
      sources,
      existingSources: [{ sourceNo: 4, assetId: "a1", url: "https://blog.example/1" }],
    });
    expect(p.newSources).toHaveLength(1);
    expect(p.newSources[0]).toMatchObject({ sourceNo: 5, assetId: "a2" });
  });

  it("差し込む行の脚注番号は既存の採番に合わせて振り直す", () => {
    const p = planAppend({
      existingBody: BODY,
      parts: { ...EMPTY_PARTS, blogImages: [{ assetId: "img", line: "- 【ブログ・画像】写真 (1/3)^[1]" }] },
      sources: [{ sourceNo: 1, label: "ブログ", url: "https://blog.example/1", date: "2026-08-03", assetId: "a1" }],
      existingSources: [{ sourceNo: 7, assetId: "a1", url: "https://blog.example/1" }],
    });
    // 生成時の ^[1] が既存の 7 番に読み替えられる
    expect(p.body).toContain("- 【ブログ・画像】写真 (1/3)^[7]");
  });

  it("節が無ければ既定の順序で作る", () => {
    const body = ["本文だけ", ""].join("\n");
    const p = planAppend({
      existingBody: body,
      parts: { ...EMPTY_PARTS, reports: ["https://x.com/zzz/status/999"] },
      sources: [],
      existingSources: [],
    });
    expect(p.body).toContain("## ファンによるミーグリレポ");
    expect(p.body).toContain("ファンが投稿したミート＆グリートの感想（X）。");
    expect(isPureAppend(body, p.body)).toBe(true);
  });

  it("TikTok は video ID で突き合わせる (短縮 URL と解決済み URL の混在)", () => {
    const withTiktok = BODY + "\n### TikTok\n\n![](https://www.tiktok.com/@u/video/7123456789)\n";
    const p = planAppend({
      existingBody: withTiktok,
      parts: { ...EMPTY_PARTS, tiktoks: ["https://www.tiktok.com/@other/video/7123456789"] },
      sources: [],
      existingSources: [],
    });
    expect(p.added.tiktoks).toBe(0);
  });
});

describe("isPureAppend", () => {
  it("行が増えただけなら true", () => {
    expect(isPureAppend("a\nb", "a\nx\nb\ny")).toBe(true);
  });

  it("既存の行が消えたら false", () => {
    expect(isPureAppend("a\nb\nc", "a\nc")).toBe(false);
  });

  it("既存の行が書き換わったら false", () => {
    expect(isPureAppend("a\nb", "a\nB")).toBe(false);
  });

  it("並べ替えは false (順序も保つ)", () => {
    expect(isPureAppend("a\nb", "b\na")).toBe(false);
  });
});

describe("appendDiff", () => {
  it("増えた行の位置を返す", () => {
    const d = appendDiff("a\nb", "a\nx\nb");
    expect(d.added).toEqual([1]);
    expect(d.lines[1]).toBe("x");
  });
});

describe("talkSortKeyFromLine", () => {
  it("タイトルの日時を並べ替えられる形にする", () => {
    expect(talkSortKeyFromLine("- 【トーク・画像】坂井新奈トーク 2026.8.2 13:15^[3]")).toBe("2026-08-02 13:15");
    // 1 桁の月日・時でも桁を揃える (文字列比較で正しく並ぶように)
    expect(talkSortKeyFromLine("坂井新奈トーク 2026.8.2 9:05")).toBe("2026-08-02 09:05");
  });

  it("日時が無い行は空", () => {
    expect(talkSortKeyFromLine("### トーク")).toBe("");
  });

  it("同じ日でも時刻で前後が決まる", () => {
    const a = talkSortKeyFromLine("トーク 2026.7.6 14:56");
    const b = talkSortKeyFromLine("トーク 2026.7.6 21:08");
    expect(a < b).toBe(true);
  });
});

describe("tiktokVideoId", () => {
  it("実 URL から取り出す", () => {
    expect(tiktokVideoId("https://www.tiktok.com/@u/video/7123?x=1")).toBe("7123");
  });

  it("短縮 URL からは取れない", () => {
    expect(tiktokVideoId("https://vt.tiktok.com/ZSabc/")).toBeNull();
  });
});
