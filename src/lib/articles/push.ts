/**
 * 一括 push の計画 (純粋関数)。
 *
 * `renderArticlesForPush` (domain) の結果と GitHub 側の tree (path → blob SHA) から、
 * 記事ごとに「push 可 / 内容が同じ / 非 public の出典あり / 衝突」を決める。
 * DB にもネットワークにも触らないので、判定はここでテストする。
 * 型もここに置く (domain が import する向き。純粋層から domain を参照しない)。
 */

interface RenderedArticleBase {
  id: string;
  shortId: string;
  /** リポジトリ内のパス。push 先のファイル名 */
  path: string;
  title: string;
  /** 取り込み時に保存した git blob SHA。null は blob SHA を埋める取り込み前 */
  githubSha: string | null;
  /**
   * レンダリング時点の `updatedAt`。push 後に `dirty` を落とすとき、commit 中に
   * 編集が入っていないことの確認に使う (入っていたら dirty のまま残す)
   */
  updatedAt: Date;
}

/**
 * push 用に組み立てた記事 1 本。`ok: false` のときは Markdown を持たない
 * (呼び出し側が確認を忘れても脚注の欠けた記事を push できないように)。
 */
export type RenderedArticle =
  | (RenderedArticleBase & {
      ok: true;
      /** 公開リポジトリに書き出す Markdown (frontmatter + 本文) */
      markdown: string;
      /** `markdown` の git blob SHA。tree との一致判定と push 後の `githubSha` に使う */
      blobSha: string;
    })
  | (RenderedArticleBase & {
      ok: false;
      /**
       * applied / unresolved なのに public でない行の脚注番号 (無ければ null)。
       * 本文が ^[n] で参照しているのに脚注が消える矛盾状態なので、push を拒否する。
       * restricted クリアランスで引いた情報なので **admin 向けの画面にしか出さない**
       * (脚注番号は公開本文にもあるので機密ではないが、方針として)
       */
      blockedSourceNos: (number | null)[];
    });

export type PushConflictReason =
  /** 取り込んだ時点から GitHub 側のファイルが変わっている (Obsidian 等で編集された) */
  | "upstream_changed"
  /** `githubSha` が無い。blob SHA を埋める取り込み (#46 以降) を実行していない */
  | "not_imported"
  /** DB には取り込み済みなのに GitHub 側にファイルが無い (削除か移動) */
  | "deleted_upstream";

/**
 * 画面用ラベル。`VERDICT_LABELS` (verify.ts) / `FAIL_REASON_LABELS` (matching.ts) と同じく、
 * このモジュール固有の union がキーなので `utils.ts` の `*_LABELS` (Prisma enum がキー) には置かない
 */
export const PUSH_CONFLICT_LABELS: Record<PushConflictReason, string> = {
  upstream_changed: "取り込み後に GitHub 側が変わっている",
  not_imported: "blob SHA 未取得 (再取り込みが必要)",
  deleted_upstream: "GitHub 側にファイルが無い",
};

export type PushPlanItem =
  | {
      kind: "ok";
      article: Extract<RenderedArticle, { ok: true }>;
      /** GitHub 側にまだ無いファイル (akashic で新規作成した記事) */
      isNew: boolean;
    }
  | { kind: "blocked"; article: Extract<RenderedArticle, { ok: false }> }
  | { kind: "conflict"; article: RenderedArticle; reason: PushConflictReason }
  /**
   * dirty だが組み立てた Markdown が GitHub 側と同じ (blob SHA が一致)。
   * コミットには載せず dirty だけ落とす。取り込みの後にシリアライザが変わって
   * 差分が消えた場合などに、空のコミットを作らないため
   */
  | { kind: "unchanged"; article: Extract<RenderedArticle, { ok: true }> };

export interface PushPlan {
  ok: Extract<PushPlanItem, { kind: "ok" }>[];
  blocked: Extract<PushPlanItem, { kind: "blocked" }>[];
  conflicts: Extract<PushPlanItem, { kind: "conflict" }>[];
  unchanged: Extract<PushPlanItem, { kind: "unchanged" }>[];
}

/**
 * 衝突判定の表:
 *
 * | tree に path | DB の githubSha | 判定 |
 * |---|---|---|
 * | あり | 一致 | push 可 |
 * | あり | 不一致 | 衝突 (upstream_changed) |
 * | あり | null | 衝突 (not_imported) |
 * | なし | null | 新規ファイル (push 可) |
 * | なし | あり | 衝突 (deleted_upstream) |
 *
 * 衝突の判定を先にする。非 public の出典 (ok: false) はどのみち push できないが、
 * 衝突している記事は「再取り込みで DB 側を作り直す」のが解消手順で、その時点で
 * 出典も作り直されるため、衝突を先に見せた方が手戻りが無い。
 */
export function planPush(rendered: RenderedArticle[], tree: Map<string, string>): PushPlan {
  const plan: PushPlan = { ok: [], blocked: [], conflicts: [], unchanged: [] };
  for (const article of rendered) {
    const upstream = tree.get(article.path);
    let reason: PushConflictReason | null = null;
    if (upstream != null) {
      if (article.githubSha == null) reason = "not_imported";
      else if (article.githubSha !== upstream) reason = "upstream_changed";
    } else if (article.githubSha != null) {
      reason = "deleted_upstream";
    }
    if (reason) plan.conflicts.push({ kind: "conflict", article, reason });
    else if (!article.ok) plan.blocked.push({ kind: "blocked", article });
    else if (upstream != null && article.blobSha === upstream) {
      plan.unchanged.push({ kind: "unchanged", article });
    } else plan.ok.push({ kind: "ok", article, isNew: upstream == null });
  }
  return plan;
}

/** sekai-nina-public も絵文字プレフィックスの慣習なので、akashic からのコミットも合わせる */
const DEFAULT_COMMIT_EMOJI = ":dog2:";
/** 一行目の上限。git の慣習は 50-72 文字だが日本語なので少し緩める。超えた分は切る */
export const COMMIT_SUBJECT_MAX = 100;

/** 既定の一行目 */
export function defaultCommitSubject(count: number): string {
  return `${DEFAULT_COMMIT_EMOJI} akashic から記事を更新 (${count} 本)`;
}

/**
 * コミットメッセージ。一行目は画面から上書きできる (空なら既定)。
 * 上書きに絵文字プレフィックスが無ければ既定のものを補い、長すぎれば切る
 * (クライアント由来なので長さを信用しない)。本文には path を列挙する
 * (GitHub 上でどの記事が変わったか、diff を開かずに分かるように)。
 */
export function buildCommitMessage(subject: string | null | undefined, paths: string[]): string {
  let line = (subject ?? "").trim().split(/\r?\n/)[0].trim();
  if (line === "") line = defaultCommitSubject(paths.length);
  else {
    if (!/^:[a-z0-9_+-]+:/.test(line)) line = `${DEFAULT_COMMIT_EMOJI} ${line}`;
    if (line.length > COMMIT_SUBJECT_MAX) line = `${line.slice(0, COMMIT_SUBJECT_MAX - 1)}…`;
  }
  return `${line}\n\n${[...paths].sort().join("\n")}\n`;
}
