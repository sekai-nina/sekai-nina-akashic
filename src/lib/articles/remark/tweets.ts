import { visit } from "unist-util-visit";
import type { Root, Image, Parent } from "mdast";

/**
 * X (Twitter) の投稿を指す画像記法を埋め込み用の blockquote に変換する。
 *
 * 記事では `![...](https://x.com/<user>/status/<id>)` と画像として書かれている。
 * sekai-nina-site はこれをクライアント JS で差し替えているが、akashic では
 * サーバー側の HTML 生成時に済ませる (クライアントの DOM 操作に依存しない)。
 * 出力するマークアップは widgets.js が探す形と同じなので見た目は揃う。
 *
 * 実データでは 16 記事に 215 件ある。
 */
const STATUS_RE = /(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/;

export function remarkTweets() {
  return (tree: Root) => {
    visit(tree, "image", (node: Image, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined) return;
      const m = node.url.match(STATUS_RE);
      if (!m) return;
      parent.children.splice(index, 1, {
        type: "html",
        value:
          `<blockquote class="twitter-tweet"><a href="https://twitter.com/x/status/${m[1]}"></a></blockquote>`,
      });
    });
  };
}
