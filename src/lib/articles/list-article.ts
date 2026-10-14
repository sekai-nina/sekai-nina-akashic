/**
 * 一覧記事 (`【2年目】日向坂で会いましょう出演一覧` 等) か。
 *
 * 公開サイトは記事の slug に「一覧」を含むものの表をスマホでカード表示にしている
 * (`.article[data-slug*="一覧"]`)。slug はファイル名 = 題なので、akashic は題で判定して
 * 本文コンテナに `data-list-article` を付ける (article-content.site.css が同じ規則を当てる)。
 */
export function isListArticle(title: string): boolean {
  return title.includes("一覧");
}
