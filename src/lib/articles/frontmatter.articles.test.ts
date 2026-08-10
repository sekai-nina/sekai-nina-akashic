import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { parseArticle } from "./frontmatter";
import { roundtrip } from "./frontmatter.test";

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

const exists = async (p?: string) => {
  if (!p) return false;
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
};

const available = await exists(ARTICLES_DIR);

/** 本文先頭の空行は 1 行に揃える (意図的な正規化) */
const canonicalBody = (s: string) => s.replace(/^(\r?\n)+/, "");
/** 空文字はキーが無いのと同じ (Astro 側でも同じ扱い) */
const canonicalValue = (v: unknown) => (v === "" || v === null ? undefined : v);

describe.skipIf(!available)("実記事の往復 (ARTICLES_DIR)", () => {
  it("全記事で frontmatter の値と本文が保たれる", async () => {
    const files = await walk(ARTICLES_DIR!);
    expect(files.length).toBeGreaterThan(300);

    const broken: string[] = [];
    for (const f of files) {
      const raw = await readFile(f, "utf8");
      const before = parseArticle(raw);
      if (String(before.frontmatter.short_id ?? "").trim() === "") continue;

      const after = parseArticle(roundtrip(raw));

      // 値が保たれているか。意図的な正規化 (lable → label、空エントリの除去、
      // 既定値キーの省略) は parseArticle 側でも同じ形になるので、
      // 専用カラムに載るキーと本文だけを突き合わせる
      const diffs: string[] = [];
      const cmp = (key: string, a: unknown, b: unknown) => {
        const x = canonicalValue(a);
        const y = canonicalValue(b);
        if (JSON.stringify(x) !== JSON.stringify(y)) {
          diffs.push(`${key}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
        }
      };
      cmp("title", before.frontmatter.title, after.frontmatter.title);
      cmp("short_id", before.frontmatter.short_id, after.frontmatter.short_id);
      cmp("tags", before.frontmatter.tags ?? [], after.frontmatter.tags ?? []);
      cmp("date_display", before.frontmatter.date_display, after.frontmatter.date_display);
      cmp("sources", before.sources, after.sources);
      cmp("body", canonicalBody(before.body), canonicalBody(after.body));

      // モデル化されていないキーは値がそのまま復元される
      for (const k of Object.keys(before.extra)) cmp(`extra.${k}`, before.extra[k], after.extra[k]);

      if (diffs.length) broken.push(`${relative(ARTICLES_DIR!, f)}\n    ${diffs.join("\n    ")}`);
    }

    expect(broken, `往復で値が変わった記事:\n  ${broken.join("\n  ")}`).toEqual([]);
  });

  it("2 回目の書き出しがバイト単位で安定する", async () => {
    // 編集していない記事に差分が出ないことの担保
    const files = await walk(ARTICLES_DIR!);
    const unstable: string[] = [];
    for (const f of files) {
      const raw = await readFile(f, "utf8");
      if (String(parseArticle(raw).frontmatter.short_id ?? "").trim() === "") continue;
      const once = roundtrip(raw);
      if (roundtrip(once) !== once) unstable.push(relative(ARTICLES_DIR!, f));
    }
    expect(unstable).toEqual([]);
  });

  it("# を含む label が YAML コメントに食われていない", async () => {
    // `label: #5 …` のように quote されていないと YAML コメント扱いになり
    // label が null になる。中身が空のテンプレート残骸 (id / url / label が
    // すべて null) は別物なので除く
    const files = await walk(ARTICLES_DIR!);
    const damaged: string[] = [];
    for (const f of files) {
      const fm = parseArticle(await readFile(f, "utf8")).frontmatter;
      for (const s of Array.isArray(fm.source) ? fm.source : []) {
        if (!s || typeof s !== "object") continue;
        const e = s as Record<string, unknown>;
        if (!("label" in e) || e.label !== null) continue;
        const hasOtherContent = e.id != null || e.url != null || e.ref != null;
        if (hasOtherContent) damaged.push(`${relative(ARTICLES_DIR!, f)} (id=${String(e.id)})`);
      }
    }
    expect(damaged).toEqual([]);
  });
});
