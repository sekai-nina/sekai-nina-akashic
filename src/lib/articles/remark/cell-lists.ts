import { visit } from "unist-util-visit";
import type { Root, Element, ElementContent } from "hast";

/**
 * 表のセルの `- ` 始まりの行を箇条書きにする (rehype 側)。
 *
 * 出演一覧の「補足」列などは `- 項目1<br>- 項目2` と書かれている。公開サイトは記事ページの
 * クライアント JS (`テーブルセル内の "- " 箇条書きをリストに変換`) で <ul> に差し替えるので、
 * 同じ見た目になるようにサーバー側で同じ変換をする。
 *
 * 公開サイトに合わせ、変換するセルは `- ` 行だけを文字として残す (セル内のリンク・`- ` で
 * 始まらない行は落ちる)。挙動を変えるなら公開サイト側と一緒に変える。
 */
export function rehypeCellLists() {
  return (tree: Root) => {
    visit(tree, "element", (td: Element) => {
      if (td.tagName !== "td") return;
      const text = cellText(td.children);
      if (!/(?:^|\n)\s*- /.test(text)) return;
      const items = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^- .+/.test(l))
        .map((l) => l.replace(/^- /, ""));
      if (items.length === 0) return;
      td.children = [
        {
          type: "element",
          tagName: "ul",
          properties: {},
          children: items.map((item) => ({
            type: "element",
            tagName: "li",
            properties: {},
            children: [{ type: "text", value: item }],
          })),
        },
      ];
    });
  };
}

/** `<br>` を改行にしたテキスト (公開サイトの innerHTML → 置換 → タグ除去と同じ結果) */
function cellText(nodes: ElementContent[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return n.value;
      if (n.type === "element") return n.tagName === "br" ? "\n" : cellText(n.children);
      return "";
    })
    .join("");
}
