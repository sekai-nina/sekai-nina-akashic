import { visitParents } from "unist-util-visit-parents";
import type { Root, Image, Parent, RootContent } from "mdast";

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
    visitParents(tree, "image", (node: Image, ancestors: Parent[]) => {
      const parent = ancestors[ancestors.length - 1];
      const index = parent?.children.indexOf(node as never);
      if (!parent || index === undefined || index === -1) return;
      if (!parent || index === undefined) return;
      const m = node.url.match(STATUS_RE);
      if (!m) return;
      // リンクに包まれた画像は <a> が空になり blockquote が外へ飛び出すので触らない
      if (parent.type === "link") return;

      const html: RootContent = {
        type: "html",
        value:
          `<blockquote class="twitter-tweet"><a href="https://twitter.com/x/status/${m[1]}"></a></blockquote>`,
      };

      // blockquote はブロック要素。段落の中に入れると parse5 が段落を割って
      // 空の <p></p> が前後に残る (コーパス全体で 118 個出ていた)。
      // 画像が段落の唯一の子なら、段落ごと差し替える。
      if (parent.type === "paragraph" && parent.children.length === 1) {
        const gp = ancestors[ancestors.length - 2] as Parent | undefined;
        const at = gp?.children.indexOf(parent as never) ?? -1;
        if (gp && at !== -1) {
          gp.children.splice(at, 1, html as never);
          return;
        }
      }
      parent.children.splice(index, 1, html);
    });
  };
}
