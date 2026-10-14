/**
 * sekai-nina-site の記事ページの CSS から本文まわりだけを抜き出し、
 * `src/app/(main)/articles/article-content.site.css` を作り直す。
 *
 * 記事のプレビュー (`/articles/[shortId]`・編集画面・お知らせ) を公開サイトと同じ見た目にするため。
 * 手で写すと公開サイトの作り直し (2026-09 の記事ページ刷新・DESIGN.md) に追いつかず
 * 見た目がずれていったので、機械的に写せるようにした。
 *
 *   pnpm cli:port-article-css --site <sekai-nina-site のパス>
 *
 * 抜き出すのは `.content :global(...)` (本文) と、body 直下に出る脚注ツールチップ・
 * 記事リンク (`:global(.footnote-…)` 等)。`.content` は `.article-content` に付け替える。
 * 一覧記事の表 (`.article[data-slug*="一覧"]`) は `.article-content[data-list-article]` にする。
 * ページ装飾 (目次・共有・出典一覧・年表 等) は持ってこない。
 * 変数 (`--fs-*` 等) は BaseLayout の `:root` にあるので article-content.css 側で定義する。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postcss, { type AtRule, type ChildNode, type Rule } from "postcss";

const OUT = "src/app/(main)/articles/article-content.site.css";
const PAGE = "src/pages/articles/[...slug].astro";

/** `:global(...)` の中身だけ残す (`:not([open])` のような入れ子の括弧に対応) */
function stripGlobal(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith(":global(", i)) {
      let depth = 1;
      let j = i + 8;
      for (; j < s.length && depth; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")") depth--;
      }
      out += s.slice(i + 8, j - 1);
      i = j;
    } else {
      out += s[i++];
    }
  }
  return out;
}

// body 直下に出る (= .content の外にある) ので素のまま持ってくるもの
const PAGE_GLOBAL =
  /^:global\((\.footnote|\.tt-action|\.internal-link|\.broken-link|\.source-ref-link|\.content)/;

// 一覧記事 (題に「一覧」) の表はスマホでカード表示にする。公開サイトは記事の slug で見ているので、
// akashic はページ側で `data-list-article` を付けて同じ規則を当てる
const LIST_ARTICLE = /^\.article\[data-slug\*="一覧"\]/;

function convertSelector(sel: string): string | null {
  const s = sel.trim();
  if (LIST_ARTICLE.test(s)) return stripGlobal(s.replace(LIST_ARTICLE, ".article-content[data-list-article]"));
  if (s.startsWith(".content")) return stripGlobal(s.replace(/^\.content\b/, ".article-content"));
  if (PAGE_GLOBAL.test(s)) return stripGlobal(s).replace(/^\.content\b/, ".article-content");
  return null;
}

/** 本文向けのセレクタだけ残す。1 つも残らなければ false */
function keepRule(rule: Rule): boolean {
  const sels = rule.selectors.map(convertSelector).filter((s): s is string => s !== null);
  if (sels.length === 0) return false;
  rule.selectors = sels;
  return true;
}

/** ルールを消すとき、その説明のコメント (直前) も一緒に落とす */
function removeWithComments(node: ChildNode) {
  let prev = node.prev();
  node.remove();
  while (prev && prev.type === "comment") {
    const p = prev.prev();
    prev.remove();
    prev = p;
  }
}

export function portArticleCss(astro: string): string {
  const start = astro.indexOf("<style>");
  const end = astro.lastIndexOf("</style>");
  if (start < 0 || end < 0) throw new Error("記事ページに <style> が見つかりません");
  const root = postcss.parse(astro.slice(start + "<style>".length, end));

  root.walkAtRules("media", (at: AtRule) => {
    for (const n of [...(at.nodes ?? [])]) {
      if (n.type === "rule" && !keepRule(n)) removeWithComments(n);
    }
    if (!at.nodes?.some((n) => n.type === "rule")) at.remove();
  });
  for (const n of [...root.nodes]) {
    if (n.type === "rule" && !keepRule(n)) removeWithComments(n);
  }

  const usedKeyframes = new Set<string>();
  root.walkDecls(/^animation/, (d) => d.value.split(/[\s,]+/).forEach((v) => usedKeyframes.add(v)));
  for (const n of [...root.nodes]) {
    if (n.type === "atrule" && n.name === "keyframes" && !usedKeyframes.has(n.params)) n.remove();
  }
  // 残ったルールの無い末尾コメント
  while (root.last?.type === "comment") root.last.remove();

  const body = root
    .toString()
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.replace(/^ {2}/, ""))
    .join("\n")
    .trim();

  return `/* ⚠ 生成ファイル。手で編集しない。
   pnpm cli:port-article-css --site <sekai-nina-site のパス> で作り直す (src/cli/port-article-css.ts)。
   sekai-nina-site の ${PAGE} の <style> から本文まわりだけを抜き出したもの。
   akashic 側の調整 (変数・Tailwind preflight の打ち消し) は article-content.css に書く。 */

${body}
`;
}

function main() {
  const i = process.argv.indexOf("--site");
  const site = i >= 0 ? process.argv[i + 1] : undefined;
  if (!site) {
    console.error("使い方: pnpm cli:port-article-css --site <sekai-nina-site のパス>");
    process.exit(1);
  }
  const css = portArticleCss(readFileSync(join(site, PAGE), "utf8"));
  writeFileSync(OUT, css);
  console.log(`${OUT} を書きました (${css.split("\n").length} 行)`);
}

if (process.argv[1]?.endsWith("port-article-css.ts")) main();
