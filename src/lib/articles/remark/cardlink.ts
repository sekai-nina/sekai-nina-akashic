// sekai-nina-site の src/utils/remark-cardlink.ts からの移植。
// 公開サイトと同じ見た目を出すため、挙動を変えずにそのまま持ってきている。
// 元を直したらこちらも直すこと (共有パッケージ化は #44 で検討)。
// mdast にしか依存しないので Astro / Next.js のどちらでも動く。

import { visit } from 'unist-util-visit';
import type { Root, Code } from 'mdast';

/**
 * Remark plugin to convert Obsidian Auto Card Link syntax to bookmark cards.
 *
 * ```cardlink
 * url: https://example.com
 * title: "Page Title"
 * host: example.com
 * favicon: https://example.com/favicon.ico
 * image: https://example.com/og.png
 * ```
 */
export function remarkCardLink() {
  return (tree: Root) => {
    visit(tree, 'code', (node: Code, index, parent) => {
      if (!parent || index === undefined) return;
      if (node.lang !== 'cardlink') return;

      const lines = node.value.split('\n');
      const data: Record<string, string> = {};

      for (const line of lines) {
        const match = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
        if (match) {
          data[match[1]] = match[2];
        }
      }

      if (!data.url) return;

      const title = data.title || data.url;
      const host = data.host || new URL(data.url).hostname;
      const favicon = data.favicon ? `<img src="${escapeAttr(data.favicon)}" alt="" class="cardlink-favicon" loading="lazy" />` : '';
      const image = data.image ? `<div class="cardlink-image"><img src="${escapeAttr(data.image)}" alt="" loading="lazy" /></div>` : '';

      const html = `<a href="${escapeAttr(data.url)}" class="cardlink" target="_blank" rel="noopener noreferrer">
  ${image}
  <div class="cardlink-content">
    <div class="cardlink-title">${escapeHtml(title)}</div>
    <div class="cardlink-meta">${favicon}<span class="cardlink-host">${escapeHtml(host)}</span></div>
  </div>
</a>`;

      parent.children.splice(index, 1, { type: 'html', value: html });
    });
  };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
