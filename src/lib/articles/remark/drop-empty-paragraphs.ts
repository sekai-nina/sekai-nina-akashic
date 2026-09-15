import { visit } from "unist-util-visit";
import type { Root, Element, Parent } from "hast";

/**
 * 空の <p></p> を落とす (rehype 側)。
 *
 * ツイート埋め込みの blockquote はブロック要素なので、本文と同じ段落にある
 * 場合に parse5 が段落を割り、前後に空の <p></p> が残る。余分な margin に
 * なるだけだが、公開サイト側はクライアントで DOM を差し替えるため発生しない
 * 差分なので消しておく。
 */
export function rehypeDropEmptyParagraphs() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined || node.tagName !== "p") return;
      const isEmpty = node.children.every(
        (c) => (c.type === "text" && c.value.trim() === "") || c.type === "comment",
      );
      if (!isEmpty) return;
      parent.children.splice(index, 1);
      return index;
    });
  };
}
