import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  diffArticleEdit,
  normalizeBody,
  parseArticleEditForm,
  toArticleEditFormValues,
  toArticleEditValues,
} from "./edit";
import { listArticleFiles } from "./files";
import { parseArticle, toArticleColumns } from "./frontmatter";

/**
 * 実記事 (sekai-nina/sekai-nina-public) を全件流して、編集フォームの往復を検証する。
 *
 * 取り込んだ値をフォームに出し、そのまま保存しても「変更なし」になること
 * (= 触っていない記事を開いて保存しただけで dirty になったり push に差分が出たりしない)。
 * `normalizeBody` の「先頭空行を落とす / 末尾は触らない」が実データに合うかは、これでしか分からない。
 *
 * `frontmatter.articles.test.ts` と同じく `ARTICLES_DIR` が指されているときだけ走る。
 */

const ARTICLES_DIR = process.env.ARTICLES_DIR;

// ARTICLES_DIR が未設定なら skip。**設定されているのに開けないなら失敗させる**
if (ARTICLES_DIR) {
  const s = await stat(ARTICLES_DIR).catch(() => null);
  if (!s?.isDirectory()) {
    throw new Error(`ARTICLES_DIR が開けません: ${ARTICLES_DIR}`);
  }
}

type Article = { rel: string; raw: string };
let articles: Article[] = [];

describe.skipIf(!ARTICLES_DIR)("実記事の編集フォーム往復 (ARTICLES_DIR)", () => {
  beforeAll(async () => {
    const files = await listArticleFiles(ARTICLES_DIR!);
    articles = await Promise.all(
      files.map(async (f) => ({ rel: relative(ARTICLES_DIR!, f), raw: await readFile(f, "utf8") })),
    );
    articles = articles.filter((a) => toArticleColumns(parseArticle(a.raw), a.rel).shortId !== "");
    expect(articles.length).toBeGreaterThan(0);
  });

  it("取り込んだ値をフォームに通してそのまま保存しても差分が出ない", () => {
    const diffs: string[] = [];
    for (const a of articles) {
      const cols = toArticleColumns(parseArticle(a.raw), a.rel);
      const prev = toArticleEditValues({
        ...cols,
        date: cols.date as Date | null,
        publishedAt: cols.publishedAt as Date | null,
        articleUpdatedAt: cols.articleUpdatedAt as Date | null,
        dateDisplay: cols.dateDisplay ?? null,
        dateMode: cols.dateMode ?? null,
        draft: cols.draft ?? false,
        unlisted: cols.unlisted ?? false,
        ongoing: cols.ongoing ?? false,
      });
      const parsed = parseArticleEditForm(toArticleEditFormValues(prev));
      if (!parsed.ok) {
        diffs.push(`${a.rel}: 検証エラー ${JSON.stringify(parsed.errors)}`);
        continue;
      }
      const changed = diffArticleEdit(prev, parsed.values);
      if (changed.length) diffs.push(`${a.rel}: ${changed.join(", ")}`);
    }
    expect(diffs).toEqual([]);
  });

  it("取り込んだ本文は normalizeBody で変わらない (正規化が取り込みと同じ規則)", () => {
    const diffs = articles
      .filter((a) => {
        const { body } = parseArticle(a.raw);
        return normalizeBody(body) !== body;
      })
      .map((a) => a.rel);
    expect(diffs).toEqual([]);
  });
});
