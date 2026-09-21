import { describe, expect, it } from "vitest";

import {
  appendDiff,
  exclusionKey,
  isPureAppend,
  planAppend,
  talkSortKeyFromLine,
  tiktokVideoId,
} from "./append";
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
      // その出典を参照する画像を足す (参照が無い出典は作られない)
      parts: { ...EMPTY_PARTS, blogImages: [{ assetId: "img", line: "- 【ひなたぼっこ日記・画像】写真^[1]" }] },
      sources: [
        { sourceNo: 1, label: "別の投稿", url: `${base}#article-70600`, date: null, assetId: "a2" },
      ],
      existingSources: [{ sourceNo: 3, assetId: "a1", url: `${base}#article-70538` }],
    });
    // 別 URL なので新しい出典として採番される (既存の 3 番に吸われない)
    expect(p.newSources).toHaveLength(1);
    expect(p.newSources[0].sourceNo).toBe(4);
  });

  it("同じレポが 2 表記で入っていても 1 本しか足さない", () => {
    const p = planAppend({
      existingBody: BODY,
      parts: {
        ...EMPTY_PARTS,
        reports: ["https://x.com/a/status/9", "https://twitter.com/a/status/9?s=20"],
      },
      sources: [],
      existingSources: [],
    });
    expect(p.added.reports).toBe(1);
    expect(p.additions).toHaveLength(1);
  });

  it("先頭行が同じ抜粋は両方足すが、チェックは 1 つにまとめる", () => {
    const parts: ArticleParts = {
      ...EMPTY_PARTS,
      quotes: [
        {
          sourceNo: 1,
          label: "ブログ",
          url: "https://example.com/1",
          date: "2026-08-02",
          excerpts: ["ありがとう\n楽しかった", "ありがとう\nまた会おうね"],
        },
      ],
    };
    const sources = [
      { sourceNo: 1, label: "ブログ", url: "https://example.com/1", date: "2026-08-02", assetId: null },
    ];
    const p = planAppend({ existingBody: BODY, parts, sources, existingSources: [] });
    expect(p.added.quotes).toBe(2);
    expect(p.additions).toHaveLength(1);

    // 外すと両方落ちる (= 出典も作らない)
    const dropped = planAppend({
      existingBody: BODY,
      parts,
      sources,
      existingSources: [],
      excluded: [p.additions[0].key],
    });
    expect(dropped.empty).toBe(true);
    expect(dropped.newSources).toHaveLength(0);
  });

  it("足すものが無い出典は作らない (frontmatter に宙に浮く出典を残さない)", () => {
    const p = planAppend({
      existingBody: BODY,
      parts: EMPTY_PARTS,
      sources: [{ sourceNo: 1, label: "誰も参照しない", url: null, date: null, assetId: "zz" }],
      existingSources: [],
    });
    expect(p.newSources).toHaveLength(0);
    expect(p.empty).toBe(true);
  });

  it("出典は末尾に採番し、既存の番号は振り直さない", () => {
    const sources: RenderedSource[] = [
      { sourceNo: 1, label: "既にあるブログ", url: "https://blog.example/1", date: "2026-08-03", assetId: "a1" },
      { sourceNo: 2, label: "新しいトーク", url: null, date: "2026-08-04", assetId: "a2" },
    ];
    const p = planAppend({
      existingBody: BODY,
      // 新しいトークを足すので、その出典だけが採番される
      parts: {
        ...EMPTY_PARTS,
        talks: [{ assetId: "a2", line: "- 【トーク・画像】新しいトーク^[2]", sortAt: null }],
      },
      sources,
      existingSources: [{ sourceNo: 4, assetId: "a1", url: "https://blog.example/1" }],
    });
    expect(p.newSources).toHaveLength(1);
    expect(p.newSources[0]).toMatchObject({ sourceNo: 5, assetId: "a2" });
    // 本文の脚注も 5 に読み替わる
    expect(p.body).toContain("新しいトーク^[5]");
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

  it("本文末尾の空行を削らない (削ると永久に追記できなくなる)", () => {
    // 編集画面で末尾に改行を 2 つ入れた記事。空行が消えると isPureAppend が false になり、
    // 「既存の本文が変化するため中止しました」から抜け出せなくなる
    const body = "本文\n\n";
    const p = planAppend({
      existingBody: body,
      parts: { ...EMPTY_PARTS, reports: ["https://x.com/zzz/status/999"] },
      sources: [],
      existingSources: [],
    });
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

describe("足さないと決めたもの (#134)", () => {
  // 実例: X 側で削除されたレポを人が記事から消したのに、追記が復活させようとした
  const REPORT = "https://x.com/ccc/status/333";

  it("除外したレポは提示されない", () => {
    const before = plan({ reports: [REPORT] });
    expect(before.added.reports).toBe(1);
    expect(before.additions.map((a) => a.key)).toContain(exclusionKey("report", REPORT));

    const after = planAppend({
      existingBody: BODY,
      parts: { ...EMPTY_PARTS, reports: [REPORT] },
      sources: [],
      existingSources: [],
      excluded: [exclusionKey("report", REPORT)],
    });
    expect(after.added.reports).toBe(0);
    expect(after.empty).toBe(true);
    expect(after.body).toBe(BODY.replace(/\n+$/, "") + "\n");
  });

  it("URL の表記が違っても同じものとして除外される", () => {
    const after = planAppend({
      existingBody: BODY,
      parts: { ...EMPTY_PARTS, reports: ["https://www.twitter.com/ccc/status/333?s=20"] },
      sources: [],
      existingSources: [],
      excluded: [exclusionKey("report", REPORT)],
    });
    expect(after.added.reports).toBe(0);
  });

  it("除外したトーク・ブログ画像も提示されない (アセット単位)", () => {
    const talkItem = { assetId: "t9", line: "- 【トーク・画像】坂井新奈トーク 2026.8.3 10:00^[9]", sortAt: null };
    const imgItem = { assetId: "i9", line: "- 【ブログ・画像】写真 (1/2)^[1]" };
    const before = plan({ talks: [talkItem], blogImages: [imgItem] });
    expect(before.added.talks + before.added.blogImages).toBe(2);

    const after = planAppend({
      existingBody: BODY,
      parts: { ...EMPTY_PARTS, talks: [talkItem], blogImages: [imgItem] },
      sources: [],
      existingSources: [],
      excluded: [exclusionKey("talk", "t9"), exclusionKey("blogImage", "i9")],
    });
    expect(after.added.talks).toBe(0);
    expect(after.added.blogImages).toBe(0);
  });

  it("除外していないものは残る", () => {
    const p = planAppend({
      existingBody: BODY,
      parts: { ...EMPTY_PARTS, reports: [REPORT, "https://x.com/ddd/status/444"] },
      sources: [],
      existingSources: [],
      excluded: [exclusionKey("report", REPORT)],
    });
    expect(p.added.reports).toBe(1);
    expect(p.body).toContain("https://x.com/ddd/status/444");
    expect(p.body).not.toContain(REPORT);
  });

  it("除外したものの出典を作らない (公開 frontmatter に残る漏れ)", () => {
    // 本文から消えても ArticleSource が作られると、記事の frontmatter に載って
    // 公開リポジトリに push される。#134 が防ごうとしている漏れそのもの
    const talkItem = { assetId: "t9", line: "- 【トーク・画像】坂井新奈トーク 2026.8.3 10:00^[1]", sortAt: null };
    const sources: RenderedSource[] = [
      { sourceNo: 1, label: "坂井新奈トーク 2026.8.3 10:00", url: null, date: "2026-08-03", assetId: "t9" },
    ];
    const p = planAppend({
      existingBody: BODY,
      parts: { ...EMPTY_PARTS, talks: [talkItem] },
      sources,
      existingSources: [],
      excluded: [exclusionKey("talk", "t9")],
    });
    expect(p.added.talks).toBe(0);
    expect(p.newSources).toHaveLength(0);
    expect(p.empty).toBe(true);
  });

  it("除外していない項目の出典は作る", () => {
    const talkItem = { assetId: "t9", line: "- 【トーク・画像】坂井新奈トーク 2026.8.3 10:00^[1]", sortAt: null };
    const sources: RenderedSource[] = [
      { sourceNo: 1, label: "坂井新奈トーク 2026.8.3 10:00", url: null, date: "2026-08-03", assetId: "t9" },
    ];
    const p = planAppend({
      existingBody: BODY,
      parts: { ...EMPTY_PARTS, talks: [talkItem] },
      sources,
      existingSources: [],
    });
    expect(p.added.talks).toBe(1);
    expect(p.newSources).toHaveLength(1);
  });

  it("additions には足すものだけが並ぶ", () => {
    const p = plan({ reports: [REPORT] });
    expect(p.additions).toHaveLength(1);
    expect(p.additions[0]).toMatchObject({ kind: "report" });
    expect(p.additions[0].label).toContain(REPORT);
  });
});

describe("exclusionKey", () => {
  it("種別ごとに前置きが変わる", () => {
    expect(exclusionKey("report", "https://x.com/a/status/1")).toBe("report:1");
    expect(exclusionKey("talk", "abc")).toBe("asset:abc");
    expect(exclusionKey("blogImage", "abc")).toBe("asset:abc");
    expect(exclusionKey("tiktok", "https://www.tiktok.com/@u/video/7123")).toBe("tiktok:7123");
  });

  it("レポは status ID で見る (ユーザー名が変わっても同じものと分かる)", () => {
    const key = exclusionKey("report", "https://x.com/a/status/1");
    expect(exclusionKey("report", "https://twitter.com/b/status/1?s=20")).toBe(key);
    expect(exclusionKey("report", "https://www.x.com/a/status/2")).not.toBe(key);
  });

  it("抜粋は本文の指紋で見る (前後の空白は無視)", () => {
    expect(exclusionKey("quote", " 同じ文章 ")).toBe(exclusionKey("quote", "同じ文章"));
    expect(exclusionKey("quote", "別の文章")).not.toBe(exclusionKey("quote", "同じ文章"));
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

describe("planAppend の引用の置き方 (#170)", () => {
  const quote = (excerpt: string): ArticleParts => ({
    ...EMPTY_PARTS,
    quotes: [{ sourceNo: 1, label: "ブログ", url: "https://example.com/1", date: "2026-08-02", excerpts: [excerpt] }],
  });
  const sources: RenderedSource[] = [
    { sourceNo: 1, label: "ブログ", url: "https://example.com/1", date: "2026-08-02", assetId: "blog" },
  ];
  const existing = [{ sourceNo: 1, assetId: "blog", url: "https://example.com/1" }];

  it("章を新しく作るときは見出しの直後の空行を残す (フル生成と同じ形)", () => {
    const p = planAppend({ existingBody: "イントロ。\n", parts: quote("新しい"), sources, existingSources: [] });
    expect(p.body).toBe(
      "イントロ。\n\n## 本人の感想（ブログより）\n\n> 新しい\n*引用: [ブログ（2026-08-02）](https://example.com/1)*^[1]\n\n"
    );
  });

  it("既にある章に足すときは前の引用と空行で区切る (1 つのブロックに繋げない)", () => {
    const body =
      "イントロ。\n\n## 本人の感想（ブログより）\n\n> 古い\n*引用: [ブログ（2026-08-02）](https://example.com/1)*^[1]\n\n## 関連メディア\n\n### トーク\n\n- 【トーク・画像】坂井新奈トーク 2026.8.2 13:15^[2]\n";
    const p = planAppend({ existingBody: body, parts: quote("新しい"), sources, existingSources: existing });
    expect(isPureAppend(body, p.body)).toBe(true);
    expect(p.body).toContain("^[1]\n\n> 新しい\n*引用:");
    expect(p.newSources).toHaveLength(0);
  });

  it("見出し無し (言葉記事) は地の文の末尾に、出典行を付けずに足す", () => {
    const layout = { quotesHeading: null, quoteAttribution: false, reports: { heading: "## x", lead: "y" } };
    const body = "坂井新奈ブログでの名言を紹介する。\n\n> 古い\n";
    const p = planAppend({ existingBody: body, parts: quote("新しい"), sources, existingSources: existing, layout });
    expect(p.body).toBe("坂井新奈ブログでの名言を紹介する。\n\n> 古い\n\n> 新しい\n\n");
  });

  it("見出し無しで地の文が無い (本文が見出しで始まる) なら、先頭見出しの上に割り込まず末尾の節に足す", () => {
    const layout = { quotesHeading: null, quoteAttribution: false, reports: { heading: "## x", lead: "y" } };
    const body = "## 名言\n\n> 古い\n";
    const p = planAppend({ existingBody: body, parts: quote("新しい"), sources, existingSources: existing, layout });
    expect(isPureAppend(body, p.body)).toBe(true);
    expect(p.body).toBe("## 名言\n\n> 古い\n\n> 新しい\n\n");
  });
});
