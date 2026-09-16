import { execFile as execFileCb } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

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
      if (isSkippedSegment(name)) continue;
      const p = join(dir, name);
      if ((await stat(p)).isDirectory()) await walk(p);
      else if (isArticlePath(relative(root, p))) out.push(p);
    }
  };
  await walk(root);
  return out;
}

function isSkippedSegment(name: string): boolean {
  return name.startsWith(".") || name === "_templates";
}

/**
 * リポジトリ相対の path が記事とみなす条件。`listArticleFiles` の walk と、GitHub の tree
 * から未取り込みの記事を探す `/status` のチェックが同じ規則を使う。
 */
export function isArticlePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (segments.some(isSkippedSegment)) return false;
  return relativePath.endsWith(".md") && relativePath !== "README.md";
}

/** CLI の `--dir <path>` か環境変数 `ARTICLES_DIR`。どちらも無ければ undefined */
export function articlesDirFromArgs(args: string[]): string | undefined {
  const i = args.indexOf("--dir");
  return i !== -1 ? args[i + 1] : process.env.ARTICLES_DIR;
}

/**
 * `git status --porcelain -z` の出力からパスを取り出す。
 *
 * `-z` は 1 エントリが `XY <path>\0`。ただし rename / copy (X が R / C) は
 * `XY <to>\0<from>\0` と **2 フィールド**になり、`<from>` には状態の 2 文字と空白が
 * 付かない。素直に \0 で割って先頭 3 文字を落とすと `<from>` の頭が欠ける。
 * `-z` を使うのは、日本語パスを git がクォート + エスケープするのを避けるため。
 */
export function parsePorcelainZ(status: string): string[] {
  const fields = status.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    paths.push(f.slice(3));
    // rename / copy は次のフィールドが移動元 (状態プレフィックス無し)
    if (f[0] === "R" || f[0] === "C") {
      const from = fields[++i];
      if (from) paths.push(from);
    }
  }
  return paths;
}

export interface CheckoutStatus {
  head: string;
  remote: string;
  /** HEAD が origin/main と一致するか */
  upToDate: boolean;
  /** `dir` がリポジトリのトップレベルか。サブディレクトリだと path がリポジトリ相対にならない */
  isTopLevel: boolean;
  /** 未コミットの変更があるファイル (取り込むと blob SHA が上流と合わず push で衝突扱いになる) */
  modified: string[];
}

/**
 * ローカル checkout の状態 (取り込みの stale 防止)。
 *
 * akashic が記事の真実になると、push 後に pull し忘れた checkout から取り込むと
 * DB が古いファイルで巻き戻る。`--apply` の前にここで止める。
 * `ls-remote` はネットワークを使うが、公開リポジトリなので認証は要らない。
 * git リポジトリでない・オフライン等で確認できないときは例外を投げる
 * (呼び出し側が「確認できない」として止めるか `--allow-stale` で進める)。
 */
export async function compareCheckoutWithRemote(dir: string, branch = "main"): Promise<CheckoutStatus> {
  const git = async (...args: string[]) => (await execFile("git", ["-C", dir, ...args])).stdout;
  const head = (await git("rev-parse", "HEAD")).trim();
  const out = (await git("ls-remote", "origin", `refs/heads/${branch}`)).trim();
  const remote = out.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(remote)) throw new Error(`origin の ${branch} を解決できません: ${out || "(空)"}`);
  // `git -C <サブディレクトリ>` でも rev-parse は通ってしまうので、トップレベルかは別に見る
  const [toplevel, real] = await Promise.all([
    git("rev-parse", "--show-toplevel").then((s) => realpath(s.trim())),
    realpath(dir),
  ]);
  const modified = parsePorcelainZ(await git("status", "--porcelain", "-z"));
  return { head, remote, upToDate: head === remote, isTopLevel: toplevel === real, modified };
}
