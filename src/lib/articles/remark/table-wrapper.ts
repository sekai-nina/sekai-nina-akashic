import { visit } from "unist-util-visit";
import type { Root, Table, Parent, RootContent } from "mdast";

/**
 * 表を `.table-wrapper` で包んで横スクロールできるようにする。
 *
 * 公開サイトはこれをクライアント JS でやっているが (記事ページの
 * initContentFeatures)、akashic ではサーバー側で済ませる。
 * 包まないと移植済みの `.article-content .table-wrapper { overflow-x: auto }`
 * が効かず、幅の広い表がレイアウトを突き破る。実データでは 23 記事に表がある。
 */
export function remarkTableWrapper() {
  return (tree: Root) => {
    visit(tree, "table", (node: Table, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined) return;
      const wrapped: RootContent[] = [
        { type: "html", value: '<div class="table-wrapper">' },
        node,
        { type: "html", value: "</div>" },
      ];
      parent.children.splice(index, 1, ...wrapped);
      return index + wrapped.length;
    });
  };
}
