// sekai-nina-site の src/utils/remark-figure-caption.ts からの移植。
// 公開サイトと同じ見た目を出すため、挙動を変えずにそのまま持ってきている。
// 元を直したらこちらも直すこと (共有パッケージ化は #44 で検討)。
// mdast にしか依存しないので Astro / Next.js のどちらでも動く。

import { visit, SKIP } from 'unist-util-visit';
import type { Root, Paragraph, Image, Emphasis, PhrasingContent, RootContent } from 'mdast';

/**
 * Remark plugin: 画像の直後に斜体行を置くと figure + figcaption に変換する。
 *
 * 対応する書き方（どちらも可）:
 *
 *   ![alt](https://.../img.png)
 *   *©︎ 坂井新奈公式ブログより引用*
 *
 *   ![alt](https://.../img.png)
 *
 *   *©︎ 坂井新奈公式ブログより引用*
 *
 * 1つ目は soft break（remarkBreaks 前に処理）で同一段落内に画像 + 斜体が入るケース、
 * 2つ目は空行で段落が分かれるケース。どちらも「画像」と「斜体だけの行」が
 * 隣接しているときにキャプション付き figure として描画する。
 *
 * 斜体の中身（リンク・strong など）は保持する。斜体マーカー `*...*` 自体は
 * キャプションの目印として使うだけで、描画時はイタリックにせず CSS で
 * キャプション体裁に整える。
 */
export function remarkFigureCaption() {
  return (tree: Root) => {
    visit(tree, 'paragraph', (node: Paragraph, index, parent) => {
      if (!parent || index === undefined) return;

      const meaningful = meaningfulChildren(node.children);

      // ケース1: 同一段落内に [画像, 斜体]
      if (meaningful.length === 2 && meaningful[0].type === 'image' && meaningful[1].type === 'emphasis') {
        const figure = buildFigure(meaningful[0] as Image, meaningful[1] as Emphasis);
        parent.children.splice(index, 1, figure);
        return [SKIP, index];
      }

      // ケース2: [画像のみ] の段落 + 次の段落が [斜体のみ]
      if (meaningful.length === 1 && meaningful[0].type === 'image') {
        const next = parent.children[index + 1];
        if (next && next.type === 'paragraph') {
          const nextMeaningful = meaningfulChildren(next.children);
          if (nextMeaningful.length === 1 && nextMeaningful[0].type === 'emphasis') {
            const figure = buildFigure(meaningful[0] as Image, nextMeaningful[0] as Emphasis);
            parent.children.splice(index, 2, figure);
            return [SKIP, index];
          }
        }
      }

      return;
    });
  };
}

/** 空白のみの text と break を無視した意味のある子ノードを返す */
function meaningfulChildren(children: PhrasingContent[]): PhrasingContent[] {
  return children.filter((c) => {
    if (c.type === 'break') return false;
    if (c.type === 'text' && /^\s*$/.test(c.value)) return false;
    return true;
  });
}

function buildFigure(img: Image, caption: Emphasis): RootContent {
  const title = img.title ? ` title="${escapeAttr(img.title)}"` : '';
  const captionHtml = inlineToHtml(caption.children);
  const html = `<figure class="article-figure">
  <img src="${escapeAttr(img.url)}" alt="${escapeAttr(img.alt || '')}"${title} loading="lazy" />
  <figcaption class="figure-caption">${captionHtml}</figcaption>
</figure>`;
  return { type: 'html', value: html };
}

/** 斜体内の phrasing content を最小限の HTML にシリアライズする */
function inlineToHtml(nodes: PhrasingContent[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return escapeHtml(n.value);
        case 'emphasis':
          return `<em>${inlineToHtml(n.children)}</em>`;
        case 'strong':
          return `<strong>${inlineToHtml(n.children)}</strong>`;
        case 'inlineCode':
          return `<code>${escapeHtml(n.value)}</code>`;
        case 'break':
          return '<br />';
        case 'link': {
          const isHttp = /^https?:\/\//.test(n.url);
          const attrs = isHttp ? ' target="_blank" rel="noopener noreferrer"' : '';
          return `<a href="${escapeAttr(n.url)}"${attrs}>${inlineToHtml(n.children)}</a>`;
        }
        case 'image':
          return `<img src="${escapeAttr(n.url)}" alt="${escapeAttr(n.alt || '')}" />`;
        default:
          // 未対応ノードは子要素があれば再帰、なければ無視
          return 'children' in n ? inlineToHtml(n.children as PhrasingContent[]) : '';
      }
    })
    .join('');
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
