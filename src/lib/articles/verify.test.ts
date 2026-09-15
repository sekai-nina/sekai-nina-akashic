import { describe, expect, it } from "vitest";

import { parseArticle, toArticleColumns, toArticleSourceRow } from "./frontmatter";
import { resolveOffline, roundtrip } from "./roundtrip";
import { compareArticle, dirtyAfterImport, lineDiff } from "./verify";

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

describe("dirtyAfterImport", () => {
  const decide = (raw: string) => {
    const cols = toArticleColumns(parseArticle(raw), "x.md");
    const { sources, ...rest } = cols;
    return dirtyAfterImport(raw, rest, resolveOffline(sources));
  };

  it("DB の出力がファイルと一致するなら dirty にしない", () => {
    // roundtrip を通した形 = 生成側が吐く形そのもの
    const raw = roundtrip(article(BASE));
    expect(decide(raw)).toEqual({ dirty: false, verdict: "identical", notes: [] });
  });

  it("引用符が違うだけ (正規化のみ) なら dirty", () => {
    const raw = article(['title: "タイトル"', "short_id: abc1234"]);
    expect(decide(raw).dirty).toBe(true);
    expect(decide(raw).verdict).toBe("normalized");
  });

  it("ref が補完されるなら dirty", () => {
    // ref 無しの行は resolveOffline では unresolved になるので、applied を直接与える
    const raw = article(["title: t", "short_id: abc1234", "source:", "  - id: 1", "    label: x"]);
    const cols = toArticleColumns(parseArticle(raw), "x.md");
    const { sources, ...rest } = cols;
    const rows = sources.map((e, i) => toArticleSourceRow(e, { assetId: "cuid9", status: "applied" }, i));
    const r = dirtyAfterImport(raw, rest, rows);
    expect(r).toEqual({ dirty: true, verdict: "ref_added", notes: ["ref を 1 件補完"] });
  });

  it("取り込みの行に非 public が混ざっていたら throw する (取り込み側の規則違反)", () => {
    const raw = article(["title: t", "short_id: abc1234", "source:", "  - id: 1", "    label: x"]);
    const cols = toArticleColumns(parseArticle(raw), "x.md");
    const { sources, ...rest } = cols;
    const rows = resolveOffline(sources).map((r) => ({ ...r, classification: "internal" as const }));
    expect(() => dirtyAfterImport(raw, rest, rows)).toThrow(/非 public/);
  });

  it("値の差分 (取りこぼし) は dirty にせず notes で知らせる", () => {
    // type が enum 外だと push で消える = changed
    const raw = article(["title: t", "short_id: abc1234", "type: unknown_type"]);
    const r = decide(raw);
    expect(r.dirty).toBe(false);
    expect(r.verdict).toBe("changed");
    expect(r.notes.some((n) => n.startsWith("type:"))).toBe(true);
  });
});
