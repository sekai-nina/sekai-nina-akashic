import { visit } from "unist-util-visit";
import type { Root, Element } from "hast";

/**
 * 本文中のリンクのうち、URL が記事の出典と一致するものに `source-ref-link` を付ける (rehype 側)。
 *
 * 公開サイトは記事ページのクライアント JS で同じ判定をし、リンクの後ろに ↗ を出している
 * (`本文中のリンクがsource URLと一致 → 出典セクションへ案内`)。見た目を揃えるため
 * サーバー側で class だけ付ける (ツールチップは持ってこない)。
 */
export function rehypeSourceRefLinks(sourceUrls: ReadonlySet<string>) {
  return () => (tree: Root) => {
    if (sourceUrls.size === 0) return;
    visit(tree, "element", (a: Element) => {
      if (a.tagName !== "a") return;
      const href = a.properties.href;
      if (typeof href !== "string" || !sourceUrls.has(href)) return;
      const cls = a.properties.className;
      // hast は className を配列に正規化している
      const list = Array.isArray(cls) ? cls.map(String) : [];
      if (list.includes("footnote-link") || list.includes("internal-link")) return;
      a.properties.className = [...list, "source-ref-link"];
    });
  };
}
