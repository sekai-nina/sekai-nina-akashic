/**
 * GitHub REST API の薄いクライアント (記事の push 用)。
 *
 * X / R2 と同じく SDK は入れず素の fetch で書く。使うのは Git Data API だけ:
 *   branch (先頭コミットと tree) → tree (path ごとの blob SHA) → tree 作成 → commit 作成 → ref 更新
 *
 * Contents API (`PUT /contents/{path}`) を使わないのは、ファイルごとに 1 コミットに
 * なるため。sekai-nina-public は push のたびに GitHub Actions が Cloudflare Pages を
 * 再ビルドするので、334 本を Contents API で書くと 334 回デプロイが走る。
 *
 * 認証は fine-grained PAT (`ARTICLES_GITHUB_TOKEN`)。sekai-nina-public の
 * Contents: Read and write だけを持たせる。`GITHUB_TOKEN` にしないのは
 * GitHub Actions が自動で注入する変数名と紛れるため。
 */

const API = "https://api.github.com";

const TOKEN = process.env.ARTICLES_GITHUB_TOKEN;
/** `owner/repo` 形式。既定は公開記事リポジトリ */
const REPO = process.env.ARTICLES_GITHUB_REPO ?? "sekai-nina/sekai-nina-public";
/** push 先ブランチ。ここに push すると Actions が公開サイトを再ビルドする */
const BRANCH = "main";
/** tree エントリの mode。通常ファイル (実行ビット無し) */
const BLOB_MODE = "100644";

export function isGithubConfigured(): boolean {
  return !!TOKEN;
}

/** `owner/repo`。画面表示とコミット URL の組み立てに使う */
export function getArticlesRepo(): string {
  return REPO;
}

/**
 * HTTP ステータスを保持したエラー。domain 層でユーザー向けに整形する。
 * `status: 0` は HTTP 以前の失敗 (トークン未設定・DNS・タイムアウト・tree の切り詰め)。
 * 呼び出し側が `status` で分岐するとき、0 は「GitHub に届いていない」と読む
 */
export class GithubApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!TOKEN) throw new GithubApiError(0, "ARTICLES_GITHUB_TOKEN が設定されていません");
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Next.js の fetch キャッシュに乗せない (branch / tree は毎回最新を見る)
      cache: "no-store",
    });
  } catch (e) {
    // DNS / TLS / タイムアウトは fetch が素の TypeError を投げる。呼び出し側が
    // GithubApiError だけを catch しているので、ここで揃えないとページごと落ちる
    throw new GithubApiError(0, `GitHub に接続できません (${method} ${path}): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { message?: string };
      detail = j.message ?? "";
    } catch {
      /* JSON でない本文は捨てる */
    }
    throw new GithubApiError(res.status, `GitHub API ${method} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

export interface BranchHead {
  commitSha: string;
  treeSha: string;
}

/** ブランチ先頭のコミットと、そのルート tree。`/branches/{branch}` は両方を 1 回で返す */
export async function getBranchHead(): Promise<BranchHead> {
  const b = await request<{ commit: { sha: string; commit: { tree: { sha: string } } } }>(
    "GET",
    `/repos/${REPO}/branches/${BRANCH}`,
  );
  return { commitSha: b.commit.sha, treeSha: b.commit.commit.tree.sha };
}

/**
 * tree を再帰で引いて path → blob SHA にする。
 *
 * GitHub は 100,000 エントリ / 7MB を超えると `truncated: true` で切り詰める。
 * 記事は 340 本程度なので当たらないが、切り詰められた tree で衝突判定をすると
 * 「path が無い = 新規」と誤るので、その場合は失敗させる。
 */
export async function getTreeBlobs(treeSha: string): Promise<Map<string, string>> {
  const tree = await request<{
    truncated: boolean;
    tree: { path: string; type: string; sha: string }[];
  }>("GET", `/repos/${REPO}/git/trees/${treeSha}?recursive=1`);
  if (tree.truncated) throw new GithubApiError(0, "tree が大きすぎて切り詰められました");
  const map = new Map<string, string>();
  for (const e of tree.tree) if (e.type === "blob") map.set(e.path, e.sha);
  return map;
}

export interface CommitFile {
  /** リポジトリ内のパス */
  path: string;
  /** ファイルの内容 (UTF-8) */
  content: string;
}

export interface CommitResult {
  commitSha: string;
  /** ブラウザで開けるコミット URL */
  url: string;
}

/**
 * 複数ファイルを 1 コミットで書き込む。
 *
 * tree は `content` を直接載せる (blob を個別に作らない)。1 リクエストで済み、
 * 記事 334 本 ≒ 740KB なら十分小さい。`base_tree` を指定するので載せなかった
 * ファイルはそのまま残る (削除には `sha: null` が要るが、ここでは送らない)。
 *
 * ref の更新は **non-force**。`parent` に載せた HEAD からブランチが進んでいると
 * 422 で拒否されるので、tree を読んでから commit するまでの間に別の push が
 * 入っても上書きしない (呼び出し側は失敗として扱い、再読み込みしてもらう)。
 *
 * ref 更新のレスポンスだけ取りこぼした (GitHub には反映済み) 場合、そのまま
 * 失敗にすると DB が更新されず次回は全件が衝突扱いになる。接続エラーのときは
 * ブランチ先頭を読み直し、作ったコミットになっていれば成功として返す。
 */
export async function commitFiles(input: {
  head: BranchHead;
  message: string;
  files: CommitFile[];
}): Promise<CommitResult> {
  const tree = await request<{ sha: string }>("POST", `/repos/${REPO}/git/trees`, {
    base_tree: input.head.treeSha,
    tree: input.files.map((f) => ({ path: f.path, mode: BLOB_MODE, type: "blob", content: f.content })),
  });
  const commit = await request<{ sha: string; html_url: string }>("POST", `/repos/${REPO}/git/commits`, {
    message: input.message,
    tree: tree.sha,
    parents: [input.head.commitSha],
  });
  try {
    await request("PATCH", `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
  } catch (e) {
    if (!(e instanceof GithubApiError) || e.status !== 0) throw e;
    const after = await getBranchHead().catch(() => null);
    if (after?.commitSha !== commit.sha) throw e;
  }
  return { commitSha: commit.sha, url: commit.html_url };
}
