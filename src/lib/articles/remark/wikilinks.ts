import { visit } from "unist-util-visit";
import type { Root, Text, Html, Parent, RootContent } from "mdast";

/**
 * Obsidian の `[[記事名]]` / `[[記事名|表示名]]` を記事へのリンクに変換する。
 *
 * 公開サイトも wikilink を記事リンクにしている (src/utils/wikilink.ts +
 * 記事ページのクライアント JS)。実データに 172 箇所あるので、変換しないと
 * 本文に生の [[...]] が残って見た目が崩れる。
 *
 * 解決は「記事タイトル -> shortId」のマップで行う。見つからない記事
 * (未作成のリンク) はリンクにせず、それと分かる装いで表示する。
 */
const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function remarkWikilinks(resolve: (title: string) => string | undefined) {
  const toHtml = (title: string, label: string) => {
    const shortId = resolve(title);
    return shortId
      ? `<a class="wikilink" href="/articles/${shortId}">${label}</a>`
      : `<span class="wikilink wikilink-missing" title="未作成の記事">${label}</span>`;
  };

  return () => (tree: Root) => {
    // コールアウトのタイトル等、先行プラグインが生 HTML にした部分も拾う
    visit(tree, "html", (node: Html) => {
      if (!node.value.includes("[[")) return;
      node.value = node.value.replace(WIKILINK, (_m, t: string, d?: string) =>
        toHtml(t.trim(), escapeHtml((d ?? t).trim())),
      );
    });

    visit(tree, "text", (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined) return;
      const value = node.value;
      if (!WIKILINK.test(value)) return;
      WIKILINK.lastIndex = 0;

      const out: RootContent[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = WIKILINK.exec(value)) !== null) {
        if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
        const title = m[1].trim();
        const label = escapeHtml((m[2] ?? m[1]).trim());
        out.push({ type: "html", value: toHtml(title, label) });
        last = m.index + m[0].length;
      }
      if (last < value.length) out.push({ type: "text", value: value.slice(last) });

      parent.children.splice(index, 1, ...out);
      return index + out.length;
    });
  };
}
