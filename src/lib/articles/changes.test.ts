import { ArticleSourceStatus, ArticleType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { hasChanged, type ComparableArticle, type ComparableSource } from "./changes";
import { parseArticle, toArticleColumns } from "./frontmatter";

/**
 * 差分スキップの判定。**誤って「変わっていない」と言うと変更が反映されない**
 * ので、各フィールドを 1 つずつ動かして検出できることを確かめる。
 */

const RAW = [
  "---",
  "title: タイトル",
  "short_id: abc1234",
  "type: attribute",
  "tags: [タグ]",
  "date: 2026-03-14",
  'date_display: "2026年3月14日"',
  "date_mode: single",
  'published_at: "2026-03-14"',
  'updated_at: "2026-03-15"',
  "draft: true",
  "lat: 35.6",
  "lng: 139.7",
  "featured: true",
  "source:",
  "  - id: 1",
  "    label: ラベル",
  "    date: 2026-03-01",
  "    ref: cuid1",
  "---",
  "",
  "本文",
  "",
].join("\n");

/** RAW を「DB に入っている状態」に見立てる */
function baseline(): { prev: ComparableArticle; cols: ReturnType<typeof toArticleColumns> } {
  const cols = toArticleColumns(parseArticle(RAW), "attribute/x.md");
  const prev: ComparableArticle = {
    path: cols.path,
    slug: cols.slug,
    title: cols.title,
    type: cols.type,
    tags: cols.tags,
    body: cols.body,
    date: cols.date as Date | null,
    dateDisplay: cols.dateDisplay ?? null,
    dateMode: cols.dateMode ?? null,
    publishedAt: cols.publishedAt as Date | null,
    articleUpdatedAt: cols.articleUpdatedAt as Date | null,
    draft: cols.draft ?? false,
    unlisted: cols.unlisted ?? false,
    ongoing: cols.ongoing ?? false,
    lat: cols.lat ?? null,
    lng: cols.lng ?? null,
    frontmatterExtra: cols.frontmatterExtra,
    sources: sourcesOf(cols),
  };
  return { prev, cols };
}

function sourcesOf(cols: ReturnType<typeof toArticleColumns>): ComparableSource[] {
  return cols.sources.map((s, i) => ({
    assetId: s.ref ?? null,
    status: ArticleSourceStatus.applied,
    sourceNo: s.id ?? null,
    label: s.label ?? "",
    url: s.url ?? null,
    date: s.date ? new Date(`${s.date}T00:00:00.000Z`) : null,
    originalRef: null,
    sortOrder: i,
  }));
}

describe("hasChanged", () => {
  it("同じ内容なら変更なしと判定する", () => {
    const { prev, cols } = baseline();
    const { sources: _s, ...next } = cols;
    expect(hasChanged(prev, next, sourcesOf(cols))).toBe(false);
  });

  // Article のカラムを 1 つずつ動かす
  const columnCases: [string, (p: ComparableArticle) => void][] = [
    ["path", (p) => (p.path = "other/x.md")],
    ["slug", (p) => (p.slug = "changed")],
    ["title", (p) => (p.title = "別のタイトル")],
    ["type", (p) => (p.type = ArticleType.event)],
    ["tags", (p) => (p.tags = ["別のタグ"])],
    ["body", (p) => (p.body = "別の本文\n")],
    ["date", (p) => (p.date = new Date("2026-03-15T00:00:00.000Z"))],
    ["dateDisplay", (p) => (p.dateDisplay = "別の表示")],
    ["dateMode", (p) => (p.dateMode = "range")],
    ["publishedAt", (p) => (p.publishedAt = new Date("2026-03-15T00:00:00.000Z"))],
    ["articleUpdatedAt", (p) => (p.articleUpdatedAt = null)],
    ["draft", (p) => (p.draft = false)],
    ["unlisted", (p) => (p.unlisted = true)],
    ["ongoing", (p) => (p.ongoing = true)],
    ["lat", (p) => (p.lat = 0)],
    ["lng", (p) => (p.lng = null)],
    ["frontmatterExtra", (p) => (p.frontmatterExtra = { featured: false })],
  ];

  it.each(columnCases)("%s が変わったら検出する", (_name, mutate) => {
    const { prev, cols } = baseline();
    mutate(prev);
    const { sources: _s, ...next } = cols;
    expect(hasChanged(prev, next, sourcesOf(cols))).toBe(true);
  });

  // ArticleSource のフィールドを 1 つずつ動かす
  const sourceCases: [string, (s: ComparableSource) => void][] = [
    ["assetId", (s) => (s.assetId = "cuid-other")],
    ["status", (s) => (s.status = ArticleSourceStatus.unresolved)],
    ["sourceNo", (s) => (s.sourceNo = 99)],
    ["label", (s) => (s.label = "別のラベル")],
    ["url", (s) => (s.url = "https://example.com")],
    ["date", (s) => (s.date = new Date("2026-03-02T00:00:00.000Z"))],
    ["originalRef", (s) => (s.originalRef = "cuid-old")],
    ["sortOrder", (s) => (s.sortOrder = 5)],
  ];

  it.each(sourceCases)("source の %s が変わったら検出する", (_name, mutate) => {
    const { prev, cols } = baseline();
    mutate(prev.sources[0]);
    const { sources: _s, ...next } = cols;
    expect(hasChanged(prev, next, sourcesOf(cols))).toBe(true);
  });

  it("source の件数が変わったら検出する", () => {
    const { prev, cols } = baseline();
    prev.sources = [];
    const { sources: _s, ...next } = cols;
    expect(hasChanged(prev, next, sourcesOf(cols))).toBe(true);
  });

  it("frontmatterExtra のキー順の違いは変更とみなさない", () => {
    // jsonb は Postgres がキーを並べ替えて保存するので、素の JSON.stringify で
    // 比べると内容が同じでも毎回「変わった」になり、差分スキップが効かない
    // (実測で 332 件中 72 件が該当していた)
    const { prev, cols } = baseline();
    prev.frontmatterExtra = { related: ["x"], author: "a", author_icon: "i" };
    const { sources: _s, ...next } = cols;
    next.frontmatterExtra = { author: "a", author_icon: "i", related: ["x"] };
    expect(hasChanged(prev, next, sourcesOf(cols))).toBe(false);
  });

  it("入れ子のキー順も無視する", () => {
    const { prev, cols } = baseline();
    prev.frontmatterExtra = { dossier: { id: "x", updated_at: "t" } };
    const { sources: _s, ...next } = cols;
    next.frontmatterExtra = { dossier: { updated_at: "t", id: "x" } };
    expect(hasChanged(prev, next, sourcesOf(cols))).toBe(false);
  });

  it("配列の順序は変更とみなす", () => {
    // tags や source[] は順序に意味がある
    const { prev, cols } = baseline();
    prev.frontmatterExtra = { related: ["a", "b"] };
    const { sources: _s, ...next } = cols;
    next.frontmatterExtra = { related: ["b", "a"] };
    expect(hasChanged(prev, next, sourcesOf(cols))).toBe(true);
  });

  it("解決先だけが変わった場合も検出する", () => {
    // 多重ヒットを unresolved に落とす変更で、カラムは同じでも
    // assetId / status が変わる。ここを見落とすと修正が反映されない
    const { prev, cols } = baseline();
    prev.sources[0] = { ...prev.sources[0], assetId: "cuid-wrong", status: ArticleSourceStatus.applied };
    const next = sourcesOf(cols).map((s) => ({
      ...s,
      assetId: null,
      status: ArticleSourceStatus.unresolved,
    }));
    const { sources: _s, ...cols2 } = cols;
    expect(hasChanged(prev, cols2, next)).toBe(true);
  });
});
