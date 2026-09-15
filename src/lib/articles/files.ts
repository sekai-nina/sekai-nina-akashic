import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * 記事リポジトリ (sekai-nina/sekai-nina-public) の Markdown を列挙する。
 *
 * 取り込み CLI・検証 CLI・実記事の往復テストが同じ集合を見るための共通関数。
 * 別々に walk を持つと「取り込みでは対象なのに検証では未取り込み扱い」のような
 * ズレが黙って生まれる。
 *
 * - ドットで始まるもの・`_templates` (Templater 式を含み記事ではない) は飛ばす
 * - リポジトリ直下の `README.md` は記事ではない
 *
 * short_id の有無はここでは見ない (parse してから呼び出し側が判断する)。
 */
export async function listArticleFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const name of await readdir(dir)) {
      if (name.startsWith(".") || name === "_templates") continue;
      const p = join(dir, name);
      if ((await stat(p)).isDirectory()) await walk(p);
      else if (name.endsWith(".md") && relative(root, p) !== "README.md") out.push(p);
    }
  };
  await walk(root);
  return out;
}

/** CLI の `--dir <path>` か環境変数 `ARTICLES_DIR`。どちらも無ければ undefined */
export function articlesDirFromArgs(args: string[]): string | undefined {
  const i = args.indexOf("--dir");
  return i !== -1 ? args[i + 1] : process.env.ARTICLES_DIR;
}
