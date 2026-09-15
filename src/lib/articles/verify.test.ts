import { describe, expect, it } from "vitest";

import { compareArticle, lineDiff } from "./verify";

/**
 * DB から組み立てた Markdown と実ファイルの突き合わせ。
 * **「値の差分」を「正規化のみ」と誤判定すると、壊れた記事が push ゲートを素通りする**
 * ので、検出すべき差分を 1 種類ずつ与えて changed になることを確かめる。
 */

const article = (fm: string[], body = "本文^[1]") => ["---", ...fm, "---", "", body, ""].join("\n");

const BASE = [
  "title: タイトル",
  "short_id: abc1234",
  "type: attribute",
  "tags: [タグ]",
  "date: 2026-03-14",
  "published_at: 2026-03-14",
  "source:",
  "  - id: 1",
  "    label: ラベル",
  "    date: 2026-03-01",
  "    ref: cuid1",
];

describe("compareArticle", () => {
  it("バイト単位で同じなら identical", () => {
    const raw = article(BASE);
    expect(compareArticle(raw, raw, "x.md")).toEqual({ verdict: "identical", notes: [] });
  });

  it("引用符・flow 配列・ゼロ埋めの違いは normalized", () => {
    const file = article(['title: "タイトル"', "short_id: abc1234", "tags: [a,b]", "date: 2026-3-4", "source:", "  - id: 1", "    label: x", "    date: 2026-1-8"]);
    const gen = article(["title: タイトル", "short_id: abc1234", "tags:", "  - a", "  - b", "date: 2026-03-04", "source:", "  - id: 1", "    label: x", "    date: 2026-01-08"]);
    expect(compareArticle(file, gen, "x.md")).toEqual({ verdict: "normalized", notes: [] });
  });

  it("元ファイルに無い ref が生えただけなら ref_added", () => {
    const file = article([...BASE.slice(0, -1)]);
    const gen = article(BASE);
    expect(compareArticle(file, gen, "x.md")).toEqual({ verdict: "ref_added", notes: ["ref を 1 件補完"] });
  });

  it("Article の日付が 1 日ズレたら changed (Date を {} に潰さない)", () => {
    // canonicalJson が Date を扱えないと、どんな日付も "{}" 同士で一致してしまう。
    // このリポジトリで繰り返している UTC/JST ズレを拾うための要
    const file = article(BASE);
    const gen = article(BASE.map((l) => l.replace("published_at: 2026-03-14", "published_at: 2026-03-15")));
    const r = compareArticle(file, gen, "x.md");
    expect(r.verdict).toBe("changed");
    expect(r.notes.some((n) => n.startsWith("publishedAt:"))).toBe(true);
  });

  it("日付が消えたら changed", () => {
    const file = article(BASE);
    const gen = article(BASE.filter((l) => !l.startsWith("date:")));
    expect(compareArticle(file, gen, "x.md").verdict).toBe("changed");
  });

  it("本文の差は changed", () => {
    const file = article(BASE, "A");
    const gen = article(BASE, "B");
    const r = compareArticle(file, gen, "x.md");
    expect(r.verdict).toBe("changed");
    expect(r.notes.some((n) => n.startsWith("body:"))).toBe(true);
  });

  it("source の件数・label・ref の変更・削除は changed", () => {
    const file = article(BASE);
    expect(compareArticle(file, article(BASE.slice(0, 6)), "x.md").notes).toContain("source の件数: 1 → 0");
    expect(compareArticle(file, article(BASE.map((l) => l.replace("label: ラベル", "label: 別"))), "x.md").verdict).toBe("changed");
    expect(compareArticle(file, article(BASE.map((l) => l.replace("ref: cuid1", "ref: cuid2"))), "x.md").verdict).toBe("changed");
    // ref が消える方向は「補完」ではない
    expect(compareArticle(file, article(BASE.slice(0, -1)), "x.md").verdict).toBe("changed");
  });

  it("source の日付が変わったら changed", () => {
    const file = article(BASE);
    const gen = article(BASE.map((l) => l.replace("date: 2026-03-01", "date: 2026-03-02")));
    expect(compareArticle(file, gen, "x.md").notes).toContain('source[0].date: "2026-03-01" → "2026-03-02"');
  });

  it("ref 追加と他の差分が同時なら changed で、ref の補完も notes に残す", () => {
    const file = article(BASE.slice(0, -1), "A");
    const gen = article(BASE, "B");
    const r = compareArticle(file, gen, "x.md");
    expect(r.verdict).toBe("changed");
    expect(r.notes).toContain("ref を 1 件補完");
  });

  it("parse が捨てる値 (enum 外の type / 読めない日付) は両辺で消えても changed", () => {
    // 両辺を同じ lossy な parse に通すので、素朴に比べると「一致」に見える
    const file = article(["short_id: abc1234", "type: quiz", "date: 2026-02-30"]);
    const gen = article(["short_id: abc1234"]);
    const r = compareArticle(file, gen, "x.md");
    expect(r.verdict).toBe("changed");
    expect(r.notes).toEqual([
      "type: quiz は ArticleType に無く push で消える",
      "date: 2026-02-30 は日付として読めず push で消える",
    ]);
  });
});

describe("lineDiff", () => {
  it("追加・削除行を +/- で出し、共通行は出さない", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc\nd")).toBe("- b\n+ x\n+ d");
  });

  it("同じなら空", () => {
    expect(lineDiff("a\nb", "a\nb")).toBe("");
  });
});
