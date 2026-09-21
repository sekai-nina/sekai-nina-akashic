import { describe, expect, it } from "vitest";

import { isPureAppend, planAppend } from "@/lib/meetgreet/append";
import type { ArticleAssetInput } from "../render";
import {
  jpDateRange,
  LIVE_PERFORMANCES_END,
  LIVE_PERFORMANCES_START,
  LIVE_TEMPLATE,
  performanceRange,
  renderLiveArticle,
  renderPerformancesBlock,
  type LivePerformanceInput,
  type LiveRenderInput,
} from "./live";

const BLOG_URL = "https://www.hinatazaka46.com/s/official/diary/detail/70435";

const asset = (over: Partial<ArticleAssetInput> & { id: string }): ArticleAssetInput => ({
  kind: "image",
  title: over.id,
  canonicalDate: "2025-09-21",
  sortAt: "2025-09-21T07:20:00.000Z",
  source: null,
  excerpts: [],
  ...over,
});
const blogText = asset({
  id: "blog-text",
  kind: "text",
  title: "坂井新奈ブログ「ツアー初日」",
  source: { kind: "url", title: "坂井新奈ブログ「ツアー初日」", url: BLOG_URL, publishedAt: "2025-09-21" },
  excerpts: ["楽しかった！"],
});
const talk = asset({
  id: "talk-1",
  title: "坂井新奈トーク 2025.9.20 22:10",
  sortAt: "2025-09-20T13:10:00.000Z",
  source: { kind: "other", title: "Talk", url: null, publishedAt: null },
});

const perf = (over: Partial<LivePerformanceInput> & { date: string; venue: string }): LivePerformanceInput => ({
  label: "",
  note: "",
  songs: [],
  centerSongs: [],
  ...over,
});
const PERFS: LivePerformanceInput[] = [
  perf({ date: "2025-09-20", venue: "セキスイハイムスーパーアリーナ（宮城）" }),
  perf({ date: "2025-09-21", venue: "セキスイハイムスーパーアリーナ（宮城）", songs: ["JOYFUL LOVE"], note: "アンコールで追加" }),
  perf({ date: "2025-11-21", venue: "横浜アリーナ", label: "夜公演", centerSongs: ["My fans"] }),
];

const input = (over: Partial<LiveRenderInput> = {}): LiveRenderInput => ({
  name: "日向坂46 ARENA TOUR 2025「MONSTER GROOVE」",
  note: "",
  performances: PERFS,
  commonSongs: ["キツネ", "NO WAR in the future 2020"],
  assets: [talk, blogText],
  reports: ["https://x.com/aaa/status/111"],
  tiktoks: [],
  thumbnailUrl: "https://r2.example/live/sketch.png",
  dossier: { id: "d1", updatedAt: "2026-09-22T00:00:00.000Z", itemCount: 2 },
  today: "2026-09-22",
  ...over,
});

describe("performanceRange / jpDateRange", () => {
  it("並び順に関係なく最小と最大。同じ年は後ろの年を省く", () => {
    expect(performanceRange([{ date: "2025-11-21" }, { date: "2025-09-20" }])).toEqual({ first: "2025-09-20", last: "2025-11-21" });
    expect(performanceRange([])).toBeNull();
    expect(jpDateRange("2025-09-20", "2025-11-21")).toBe("2025年9月20日〜11月21日");
    expect(jpDateRange("2025-12-30", "2026-01-02")).toBe("2025年12月30日〜2026年1月2日");
    expect(jpDateRange("2026-04-04", "2026-04-04")).toBe("2026年4月4日");
  });
});

describe("renderPerformancesBlock", () => {
  it("手書きの一覧と同じ形。空の列は出さず、共通披露曲を表の下に", () => {
    expect(renderPerformancesBlock({ performances: PERFS, commonSongs: ["キツネ", "NO WAR in the future 2020"] })).toEqual([
      "| 日付 | 会場 | 追加曲 | センター曲 | 備考 |",
      "| --- | --- | --- | --- | --- |",
      "| 2025/9/20 | セキスイハイムスーパーアリーナ（宮城） |  |  |  |",
      "| 2025/9/21 | セキスイハイムスーパーアリーナ（宮城） | JOYFUL LOVE |  | アンコールで追加 |",
      "| 2025/11/21 夜公演 | 横浜アリーナ |  | My fans |  |",
      "共通披露曲：キツネ / NO WAR in the future 2020",
    ]);
    expect(renderPerformancesBlock({ performances: [perf({ date: "2026-04-04", venue: "横浜スタジアム" })], commonSongs: [] })).toEqual([
      "| 日付 | 会場 |",
      "| --- | --- |",
      "| 2026/4/4 | 横浜スタジアム |",
    ]);
    expect(renderPerformancesBlock({ performances: [], commonSongs: [] })).toEqual(["（公演は未設定）"]);
  });

  it("セルの | と改行は潰す", () => {
    const lines = renderPerformancesBlock({ performances: [perf({ date: "2026-04-04", venue: "A|B", note: "x\ny" })], commonSongs: [] });
    expect(lines[2]).toBe("| 2026/4/4 | A／B | x y |");
  });
});

describe("renderLiveArticle", () => {
  it("サムネ → イントロ → 公演 (マーカー区間) → 感想 → レポ → 関連メディア。date は初日、range", () => {
    const r = renderLiveArticle(input());
    expect(r.title).toBe("日向坂46 ARENA TOUR 2025「MONSTER GROOVE」");
    expect(r.tags).toEqual(["ライブ"]);
    expect(r.body).toBe(
      [
        '<img src="https://r2.example/live/sketch.png" alt="日向坂46 ARENA TOUR 2025「MONSTER GROOVE」 サムネイル" width="600">',
        "",
        "2025年9月20日〜11月21日、日向坂46 ARENA TOUR 2025「MONSTER GROOVE」が開催された。坂井新奈は3公演に参加した。",
        "",
        "## 公演",
        "",
        LIVE_PERFORMANCES_START,
        "| 日付 | 会場 | 追加曲 | センター曲 | 備考 |",
        "| --- | --- | --- | --- | --- |",
        "| 2025/9/20 | セキスイハイムスーパーアリーナ（宮城） |  |  |  |",
        "| 2025/9/21 | セキスイハイムスーパーアリーナ（宮城） | JOYFUL LOVE |  | アンコールで追加 |",
        "| 2025/11/21 夜公演 | 横浜アリーナ |  | My fans |  |",
        "共通披露曲：キツネ / NO WAR in the future 2020",
        LIVE_PERFORMANCES_END,
        "",
        "## 本人の感想（ブログより）",
        "",
        "> 楽しかった！",
        "*引用: [坂井新奈ブログ「ツアー初日」（2025-09-21）](https://www.hinatazaka46.com/s/official/diary/detail/70435)*^[1]",
        "",
        "## ファンによるライブレポ",
        "",
        "ファンが投稿したライブの感想（X）。",
        "",
        "![](https://x.com/aaa/status/111)",
        "",
        "## 関連メディア",
        "",
        "### トーク",
        "",
        "- 【トーク・画像】坂井新奈トーク 2025.9.20 22:10^[2]",
        "",
      ].join("\n")
    );
    expect(r.dates).toEqual({ date: "2025-09-20", dateDisplay: "2025年9月20日〜11月21日", dateMode: "range" });
    expect(r.draft).toBe(false);
    expect(r.frontmatterExtra).toEqual({
      dossier: { id: "d1", updated_at: "2026-09-22T00:00:00.000Z", item_count: 2, synced_at: "2026-09-22" },
      live: {
        name: "日向坂46 ARENA TOUR 2025「MONSTER GROOVE」",
        common_songs: ["キツネ", "NO WAR in the future 2020"],
        performances: [
          { date: "2025-09-20", venue: "セキスイハイムスーパーアリーナ（宮城）", label: "", songs: [], center_songs: [], note: "" },
          { date: "2025-09-21", venue: "セキスイハイムスーパーアリーナ（宮城）", label: "", songs: ["JOYFUL LOVE"], center_songs: [], note: "アンコールで追加" },
          { date: "2025-11-21", venue: "横浜アリーナ", label: "夜公演", songs: [], center_songs: ["My fans"], note: "" },
        ],
        outfit_image: "https://r2.example/live/sketch.png",
      },
    });
    expect(r.parts.blocks).toHaveLength(1);
    expect(r.parts.reports).toEqual(["https://x.com/aaa/status/111"]);
  });

  it("1 公演なら単日 (range 無し)、公演が無ければ日付無しで注記、note は公演の章の頭", () => {
    const one = renderLiveArticle(input({ performances: [PERFS[0]], note: "セットリスト違いの A / B パターン" }));
    expect(one.dates).toEqual({ date: "2025-09-20", dateDisplay: "2025年9月20日", dateMode: null });
    expect(one.body).toContain("2025年9月20日、日向坂46 ARENA TOUR 2025「MONSTER GROOVE」が開催された。坂井新奈は1公演に参加した。");
    expect(one.body).toContain("## 公演\n\nセットリスト違いの A / B パターン\n\n<!-- live:performances -->");
    const none = renderLiveArticle(input({ performances: [], thumbnailUrl: null }));
    expect(none.dates).toEqual({ date: null, dateDisplay: null, dateMode: null });
    expect(none.body.startsWith("日向坂46 ARENA TOUR 2025「MONSTER GROOVE」が開催された。\n\n## 公演\n\n<!-- live:performances -->\n（公演は未設定）")).toBe(true);
    expect(none.frontmatterExtra.live.outfit_image).toBeUndefined();
  });
});

describe("ライブ記事の追記 (公演の表は毎回差し替え)", () => {
  it("公演を直すとマーカーの中身だけ変わり、他は触らない。純粋な追記として通る", () => {
    const before = renderLiveArticle(input());
    const after = renderLiveArticle(input({ performances: [...PERFS, perf({ date: "2025-12-01", venue: "追加公演" })] }));
    const p = planAppend({
      existingBody: before.body,
      parts: after.parts,
      sources: after.sources,
      existingSources: [
        { sourceNo: 1, assetId: "blog-text", url: BLOG_URL },
        { sourceNo: 2, assetId: "talk-1", url: null },
      ],
      layout: LIVE_TEMPLATE.appendLayout,
    });
    expect(p.blocksChanged).toBe(true);
    expect(p.empty).toBe(false);
    expect(p.newSources).toHaveLength(0);
    expect(p.body).toContain("| 2025/12/1 | 追加公演 |");
    // マーカーの外は 1 行も変わらない
    expect(isPureAppend(p.baseBody, p.body)).toBe(true);
    expect(p.body.replace(/<!-- live:performances -->[\s\S]*?<!-- \/live:performances -->/, "BLOCK")).toBe(
      before.body.replace(/<!-- live:performances -->[\s\S]*?<!-- \/live:performances -->/, "BLOCK")
    );
  });

  it("何も変わっていなければ empty", () => {
    const r = renderLiveArticle(input());
    const p = planAppend({
      existingBody: r.body,
      parts: r.parts,
      sources: r.sources,
      existingSources: [
        { sourceNo: 1, assetId: "blog-text", url: BLOG_URL },
        { sourceNo: 2, assetId: "talk-1", url: null },
      ],
      layout: LIVE_TEMPLATE.appendLayout,
    });
    expect(p.blocksChanged).toBe(false);
    expect(p.empty).toBe(true);
    expect(p.body).toBe(r.body);
  });

  it("マーカーが消された / 旧い記事には `## 公演` の章を作ってマーカーごと置き、新しいレポも足す", () => {
    const r = renderLiveArticle(input({ reports: ["https://x.com/aaa/status/111", "https://x.com/bbb/status/222"] }));
    const existing = "イントロ。\n\n## ファンによるライブレポ\n\nファンが投稿したライブの感想（X）。\n\n![](https://x.com/aaa/status/111)\n";
    const p = planAppend({
      existingBody: existing,
      parts: r.parts,
      sources: r.sources,
      existingSources: [],
      layout: LIVE_TEMPLATE.appendLayout,
    });
    expect(p.blocksChanged).toBe(true);
    expect(p.added.reports).toBe(1);
    const perfAt = p.body.indexOf("## 公演");
    const repAt = p.body.indexOf("## ファンによるライブレポ");
    expect(perfAt).toBeGreaterThan(0);
    expect(perfAt).toBeLessThan(repAt);
    expect(p.body).toContain(`${LIVE_PERFORMANCES_START}\n| 日付 |`);
    expect(p.body).toContain("![](https://x.com/bbb/status/222)");
    expect(isPureAppend(p.baseBody, p.body)).toBe(true);
  });
});
