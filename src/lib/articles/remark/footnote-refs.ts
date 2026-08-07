import { visit } from "unist-util-visit";
import type { Root, Text, Html, Parent, RootContent } from "mdast";

/**
 * 本文中の `^[n]` を出典一覧へのアンカーリンクに変換する。
 *
 * これは akashic 独自のプラグイン (sekai-nina-site には無い)。
 * 公開サイトは `^[n]` をクライアント JS でホバーポップアップにしているが、
 * akashic では出典が ArticleSource として構造化され、詳細ページに一覧が
 * あるので、そこへ飛ばすだけで足りる (#40 の設計合意 5)。
 *
 * 実データでは 214 記事に 1536 箇所ある。
 */
const REF = /\^\[(\d+)\]/g;

const toAnchor = (n: string) =>
  `<sup class="footnote-ref"><a href="#source-${n}" data-source-no="${n}">${n}</a></sup>`;

export function remarkFootnoteRefs() {
  return (tree: Root) => {
    // 先に走る remarkObsidianCallouts がコールアウトのタイトルを生 HTML ノードに
    // 変換してしまうため、text ノードだけを見ていると中の ^[n] を取りこぼす。
    visit(tree, "html", (node: Html) => {
      if (node.value.includes("^[")) {
        node.value = node.value.replace(/\^\[(\d+)\]/g, (_, n) => toAnchor(n));
      }
    });

    visit(tree, "text", (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined) return;
      const value = node.value;
      if (!REF.test(value)) return;
      REF.lastIndex = 0;

      const out: RootContent[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = REF.exec(value)) !== null) {
        if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
        const n = m[1];
        out.push({ type: "html", value: toAnchor(n) });
        last = m.index + m[0].length;
      }
      if (last < value.length) out.push({ type: "text", value: value.slice(last) });

      parent.children.splice(index, 1, ...out);
      // 差し込んだ分をスキップする (再訪すると無限ループになる)
      return index + out.length;
    });
  };
}
