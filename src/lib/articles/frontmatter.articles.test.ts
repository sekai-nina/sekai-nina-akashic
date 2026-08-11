import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { parseArticle, toArticleColumns, type ArticleColumns } from "./frontmatter";
import { roundtrip } from "./roundtrip";

/**
 * 実記事 (sekai-nina/sekai-nina-public) を全件流して往復を検証する。
 *
 * 記事は別リポジトリなので CI には存在しない。`ARTICLES_DIR` が指されていて
 * 実在するときだけ走らせる。ローカルでは
 *
 *   ARTICLES_DIR=../sekai-nina-site/src/content/articles pnpm test
 *
 * のように指定する。push を実装する前 (#46) にはこれを緑にしておく。
 */

const ARTICLES_DIR = process.env.ARTICLES_DIR;

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const name of await readdir(dir)) {
    // _templates は Templater 式 (<%* … %>) を含み取り込み対象外
    if (name.startsWith(".") || name === "_templates") continue;
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) await walk(p, out);
    else if (name.endsWith(".md") && name !== "README.md") out.push(p);
  }
  return out;
}

// ARTICLES_DIR が未設定なら skip。**設定されているのに開けないなら失敗させる**
// (タイポで全部 skip されて緑に見えるのが一番まずい)
if (ARTICLES_DIR) {
  const s = await stat(ARTICLES_DIR).catch(() => null);
  if (!s?.isDirectory()) {
    throw new Error(`ARTICLES_DIR が開けません: ${ARTICLES_DIR}`);
  }
}

type Article = { rel: string; raw: string };
let articles: Article[] = [];

describe.skipIf(!ARTICLES_DIR)("実記事の往復 (ARTICLES_DIR)", () => {
  beforeAll(async () => {
    const files = await walk(ARTICLES_DIR!);
    articles = await Promise.all(
      files.map(async (f) => ({ rel: relative(ARTICLES_DIR!, f), raw: await readFile(f, "utf8") })),
    );
    // short_id の無いファイルは取り込み対象外
    articles = articles.filter((a) => toArticleColumns(parseArticle(a.raw), a.rel).shortId !== "");
    expect(articles.length).toBeGreaterThan(0);
  });

  it("全記事で Article のカラムが保たれる", () => {
    /** 比較対象は toArticleColumns が返すカラムそのもの。キーを増やすと自動で対象に入る */
    const compare = (a: ArticleColumns, b: ArticleColumns) => {
      const diffs: string[] = [];
      const keys = Object.keys(a) as (keyof ArticleColumns)[];
      for (const k of keys) {
        // path は往復に含まれない (ファイルの置き場所は frontmatter に無い)
        if (k === "path") continue;
        const x = a[k] instanceof Date ? (a[k] as Date).toISOString() : a[k];
        const y = b[k] instanceof Date ? (b[k] as Date).toISOString() : b[k];
        if (JSON.stringify(x) !== JSON.stringify(y)) {
          diffs.push(`${String(k)}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
        }
      }
      return diffs;
    };

    const broken: string[] = [];
    for (const { rel, raw } of articles) {
      const before = toArticleColumns(parseArticle(raw), rel);
      const after = toArticleColumns(parseArticle(roundtrip(raw, rel)), rel);
      const diffs = compare(before, after);
      if (diffs.length) broken.push(`${rel}\n    ${diffs.join("\n    ")}`);
    }

    expect(broken, `往復でカラムが変わった記事:\n  ${broken.join("\n  ")}`).toEqual([]);
  });

  it("モデル化されていない frontmatter のキーが保たれる", () => {
    const broken: string[] = [];
    for (const { rel, raw } of articles) {
      const before = parseArticle(raw).extra;
      const after = parseArticle(roundtrip(raw, rel)).extra;
      for (const k of Object.keys(before)) {
        if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
          broken.push(`${rel}  extra.${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("1 回目の書き出しで本文が確定し、2 回目はバイト単位で安定する", () => {
    // 編集していない記事に差分が出ないことの担保。
    // 本文も 1 回目で収束する (parse / serialize が先頭改行について対称なので)
    const unstable: string[] = [];
    for (const { rel, raw } of articles) {
      const once = roundtrip(raw, rel);
      if (roundtrip(once, rel) !== once) unstable.push(rel);
    }
    expect(unstable).toEqual([]);
  });

  it("DB に入る本文が元ファイルの本文と一致する", () => {
    // #46 は本文の差分で dirty を判定する。parse と serialize が非対称だと
    // 取り込んだ直後から DB とファイルが食い違い、永久に dirty 扱いになる
    const differ: string[] = [];
    for (const { rel, raw } of articles) {
      const fromFile = parseArticle(raw).body;
      const afterPush = parseArticle(roundtrip(raw, rel)).body;
      if (fromFile !== afterPush) differ.push(rel);
    }
    expect(differ).toEqual([]);
  });

  it("# を含む label が YAML コメントに食われていない", () => {
    // `label: #5 …` のように quote されていないと YAML コメント扱いになり
    // label が null になる。中身が空のテンプレート残骸 (id / url / label が
    // すべて null) は別物なので除く
    const damaged: string[] = [];
    for (const { rel, raw } of articles) {
      const fm = parseArticle(raw).frontmatter;
      for (const s of Array.isArray(fm.source) ? fm.source : []) {
        if (!s || typeof s !== "object") continue;
        const e = s as Record<string, unknown>;
        if (!("label" in e) || e.label !== null) continue;
        const hasOtherContent = e.id != null || e.url != null || e.ref != null;
        if (hasOtherContent) damaged.push(`${rel} (id=${String(e.id)})`);
      }
    }
    expect(damaged).toEqual([]);
  });

  it("暦日として存在しない日付が入っていない", () => {
    // parseFrontmatterDate は不正な日付を null にするので、取り込むと
    // 日付が黙って消える。元ファイル側で気づけるようにする
    const bad: string[] = [];
    for (const { rel, raw } of articles) {
      const fm = parseArticle(raw).frontmatter;
      const check = (where: string, v: unknown) => {
        if (v == null || v === "") return;
        const s = String(v).trim();
        if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return;
        const [y, mo, d] = s.split("-");
        const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
        const dt = new Date(`${iso}T00:00:00.000Z`);
        if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) {
          bad.push(`${rel}  ${where}: ${s}`);
        }
      };
      for (const k of ["date", "published_at", "updated_at"]) check(k, fm[k]);
      for (const [i, s] of (Array.isArray(fm.source) ? fm.source : []).entries()) {
        if (s && typeof s === "object") check(`source[${i}].date`, (s as Record<string, unknown>).date);
      }
    }
    expect(bad).toEqual([]);
  });
});
