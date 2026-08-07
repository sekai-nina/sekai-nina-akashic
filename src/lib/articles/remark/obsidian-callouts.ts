// sekai-nina-site の src/utils/remark-obsidian-callouts.ts からの移植。
// 公開サイトと同じ見た目を出すため、挙動を変えずにそのまま持ってきている。
// 元を直したらこちらも直すこと (共有パッケージ化は #44 で検討)。
// mdast にしか依存しないので Astro / Next.js のどちらでも動く。

import { visit } from 'unist-util-visit';
import type { Root, Blockquote, Paragraph, Text, PhrasingContent } from 'mdast';

/**
 * Remark plugin to convert Obsidian callout syntax to HTML.
 *
 * Obsidian callout syntax:
 *   > [!type] Title        → styled callout (always open)
 *   > [!type]- Title       → collapsible, default closed
 *   > [!type]+ Title       → collapsible, default open
 *   > content...
 *
 * Collapsible callouts become <details><summary> elements.
 * Non-collapsible callouts become styled <div> elements.
 */

const CALLOUT_REGEX = /^\[!(\w+)\]([+-])?\s*(.*)/;

function getCalloutLabel(type: string): string {
  const labels: Record<string, string> = {
    note: 'ノート',
    info: '情報',
    tip: 'ヒント',
    hint: 'ヒント',
    important: '重要',
    warning: '警告',
    caution: '注意',
    danger: '危険',
    error: 'エラー',
    question: '質問',
    faq: 'FAQ',
    example: '例',
    quote: '引用',
    cite: '引用',
    abstract: '概要',
    summary: '概要',
    tldr: 'TL;DR',
    todo: 'TODO',
    success: '成功',
    check: '完了',
    done: '完了',
    failure: '失敗',
    fail: '失敗',
    missing: '不足',
    bug: 'バグ',
  };
  return labels[type] || type;
}

export function remarkObsidianCallouts() {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node: Blockquote, index, parent) => {
      if (!parent || index === undefined) return;

      // Check if first child is a paragraph with callout syntax
      const firstChild = node.children[0];
      if (!firstChild || firstChild.type !== 'paragraph') return;

      const firstInline = firstChild.children[0];
      if (!firstInline || firstInline.type !== 'text') return;

      const match = firstInline.value.match(CALLOUT_REGEX);
      if (!match) return;

      const [, type, foldMarker, title] = match;
      const typeLower = type.toLowerCase();
      const displayTitle = title || getCalloutLabel(typeLower);
      const isCollapsible = foldMarker === '-' || foldMarker === '+';
      const isOpen = foldMarker === '+';

      // Remove the callout marker from the first paragraph
      // If the marker was the entire text, remove the text node
      const remainingText = firstInline.value.replace(CALLOUT_REGEX, '').trim();

      // Build the inner content (remaining paragraphs from the blockquote)
      const innerChildren = [...node.children];

      // Handle first paragraph: remove marker text, keep remaining inline content
      const firstPara = innerChildren[0] as Paragraph;
      const remainingInlines: PhrasingContent[] = [];

      if (remainingText) {
        remainingInlines.push({ type: 'text', value: remainingText } as Text);
      }
      // Keep other inline children of the first paragraph (bold, links, etc.)
      remainingInlines.push(...firstPara.children.slice(1));

      // If there's remaining content in the first paragraph, update it
      if (remainingInlines.length > 0) {
        innerChildren[0] = { ...firstPara, children: remainingInlines };
      } else {
        innerChildren.shift();
      }

      const isToggle = typeLower === 'toggle';

      if (isCollapsible || isToggle) {
        // toggle type is always collapsible (default closed)
        const openAttr = (isOpen || (isToggle && foldMarker === '+')) ? ' open' : '';
        const cls = isToggle ? 'callout-toggle' : `callout callout-${typeLower}`;
        const titleCls = isToggle ? 'callout-toggle-title' : 'callout-title';
        const contentCls = isToggle ? 'callout-toggle-content' : 'callout-content';
        const summaryHtml = `<details class="${cls}"${openAttr}><summary class="${titleCls}">${escapeHtml(displayTitle)}</summary><div class="${contentCls}">`;
        const closingHtml = `</div></details>`;

        parent.children.splice(index!, 1,
          { type: 'html', value: summaryHtml },
          ...innerChildren,
          { type: 'html', value: closingHtml },
        );
      } else {
        // Non-collapsible callout: styled div
        const openHtml = `<div class="callout callout-${typeLower}"><div class="callout-title">${escapeHtml(displayTitle)}</div><div class="callout-content">`;
        const closingHtml = `</div></div>`;

        parent.children.splice(index!, 1,
          { type: 'html', value: openHtml },
          ...innerChildren,
          { type: 'html', value: closingHtml },
        );
      }
    });
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
