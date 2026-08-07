// sekai-nina-site の src/utils/remark-quote-markers.ts からの移植。
// 公開サイトと同じ見た目を出すため、挙動を変えずにそのまま持ってきている。
// 元を直したらこちらも直すこと (共有パッケージ化は #44 で検討)。
// mdast にしか依存しないので Astro / Next.js のどちらでも動く。

import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';

/**
 * Remark plugin to process quote markers in markdown:
 * - Remove {q} and {/q} markers (including {q id="..."})
 * - Remove {br/} markers
 * - Convert {nobr}...{/nobr} to HTML spans
 */
export function remarkQuoteMarkers() {
  return (tree: Root) => {
    visit(tree, 'text', (node: any) => {
      if (typeof node.value === 'string') {
        let text = node.value;

        // Remove {q} and {/q} markers (including {q id="..."})
        text = text.replace(/\{q(?:\s+id\s*=\s*["'][^"']*["'])?\}/g, '');
        text = text.replace(/\{\/q\}/g, '');

        // Remove {br/} markers
        text = text.replace(/\{br\/\}/g, '');

        // Process {nobr}...{/nobr} - keep as is for now, will be processed client-side
        // (or convert to HTML if needed)

        node.value = text;
      }
    });
  };
}
