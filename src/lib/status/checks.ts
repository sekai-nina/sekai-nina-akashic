import { Prisma } from "@prisma/client";
import { isArticlePath } from "@/lib/articles/files";
import { classificationFilterSql } from "@/lib/classification";
import { prisma, prismaInternal } from "@/lib/db";
import { sourcePatternConds } from "@/lib/domain/coverage";
import { getBranchHead, getTreeBlobs, isGithubConfigured } from "@/lib/github/client";
import { isR2Configured } from "@/lib/r2";
import { thumbnailPendingWhere } from "@/lib/thumbnails";
import { CHECK_GROUPS } from "@/lib/utils";
import { judgeFreshness, judgeHeartbeat } from "./judge";
import {
  ARTICLE_DIRTY_MAX_AGE_DAYS,
  CHECK_TIMEOUT_MS,
  DETAIL_LIMIT,
  DISCOVERY_WINDOW_DAYS,
  EXPECTED_JOBS,
  SOURCE_FRESHNESS_MAX_AGE_HOURS,
  type CheckContext,
  type CheckDefinition,
  type CheckOutcome,
} from "./types";

/**
 * チェックの実装。
 *
 * 保護テーブルは `prismaInternal` で数える。cron はユーザーのセッション外で走るので素の `prisma` では
 * 保護テーブルが RLS で 0 行になる (全体統計と同じ扱い。`docs/security-dev.md`)。
 * ただし結果は非保護の StatusCheckState に写ってログイン済み全員に見えるので、
 * **detail に載せる名前・タイトルは `internal` 以下のものに限る** (`STATUS_VISIBLE_CLEARANCE`)。
 * confidential 以上の行は件数にも入れない。Job / StatusCheckState は非保護なので素の `prisma`。
 */

/** /status に写してよい上限。全ユーザーが internal 以上の前提はここだけに閉じる */
const STATUS_VISIBLE_CLEARANCE = "internal" as const;

// ---------------------------------------------------------------------------
// 収集: DataSource ごとの最終登録
// ---------------------------------------------------------------------------

async function sourceFreshnessChecks(): Promise<CheckDefinition[]> {
  const sources = await prismaInternal.dataSource.findMany({
    where: {
      key: { in: Object.keys(SOURCE_FRESHNESS_MAX_AGE_HOURS) },
      active: true,
      // 名前を StatusCheckState に写すので、全員に見せてよい DataSource だけ
      classification: { in: ["public", STATUS_VISIBLE_CLEARANCE] },
    },
    orderBy: { sortOrder: "asc" },
    select: { key: true, name: true, publisherPattern: true, titlePattern: true },
  });
  return sources.map((ds) => ({
    key: `collect.${ds.key}`,
    group: "collect" as const,
    name: ds.name,
    description: "SourceRecord の最終登録時刻 (DataSource の publisher / title パターンで絞る)",
    notify: true,
    async run({ now }) {
      const conds = sourcePatternConds(ds);
      const where = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}` : Prisma.empty;
      const rows = await prismaInternal.$queryRaw<{ last: Date | null }[]>`
        SELECT MAX(sr."createdAt") AS last FROM "SourceRecord" sr ${where}`;
      return judgeFreshness(rows[0]?.last ?? null, SOURCE_FRESHNESS_MAX_AGE_HOURS[ds.key], now);
    },
  }));
}

// ---------------------------------------------------------------------------
// ハートビート: 期待ジョブ + 報告があった未知のジョブ
// ---------------------------------------------------------------------------

async function heartbeatChecks(): Promise<CheckDefinition[]> {
  const jobs = await prisma.job.findMany({
    select: {
      key: true,
      name: true,
      intervalSec: true,
      lastRunAt: true,
      lastOkAt: true,
      lastStatus: true,
      lastMessage: true,
    },
  });
  const byKey = new Map(jobs.map((j) => [j.key, j]));
  const expectedKeys = new Set(EXPECTED_JOBS.map((j) => j.key));
  const entries = [
    ...EXPECTED_JOBS,
    // 期待表に無い key で報告が来たジョブも見せる (報告側が先に増えても取りこぼさない)
    ...jobs.filter((j) => !expectedKeys.has(j.key)).map((j) => ({ key: j.key, name: j.name, group: "workers" as const })),
  ];
  return entries.map((e) => {
    const job = byKey.get(e.key) ?? null;
    // 報告側が name を省くと Job.name は key になる。それでは期待表の表示名を潰さない
    const reportedName = job && job.name !== job.key ? job.name : null;
    return {
      key: `job.${e.key}`,
      group: e.group,
      name: reportedName ?? e.name,
      description: "ハートビート (POST /api/v1/jobs/{key}/runs) の最終成功と最後の結果",
      notify: true,
      async run({ now }) {
        return judgeHeartbeat(job, now);
      },
    };
  });
}

// ---------------------------------------------------------------------------
// 加工
// ---------------------------------------------------------------------------

const discoveryUnextracted: CheckDefinition = {
  key: "process.discovery_unextracted",
  group: "process",
  name: "今日の発見の抽出",
  description: `直近 ${DISCOVERY_WINDOW_DAYS} 日の坂井新奈ブログで、本文に「今日の発見」があるのにタグが無いもの`,
  notify: true,
  async run({ now }) {
    const since = new Date(now.getTime() - DISCOVERY_WINDOW_DAYS * 86_400_000);
    // 発見なしの回 (「今日の発見はお休み」等) もここに乗るが、期間を過ぎれば消える。
    // bot は新着から数分で抽出するので、期間内に残っているものは抽出待ちか失敗。
    // 本文の検索は EXISTS にして、body が複数行あっても同じアセットを 2 度出さない
    const rows = await prismaInternal.$queryRaw<{ id: string; title: string; canonicalDate: Date | null }[]>`
      SELECT a.id, a.title, a."canonicalDate"
      FROM "Asset" a
      WHERE a.kind = 'text'
        AND a."createdAt" >= ${since}
        AND ${classificationFilterSql(STATUS_VISIBLE_CLEARANCE, "a")}
        AND EXISTS (
          SELECT 1 FROM "AssetEntity" pe JOIN "Entity" p ON p.id = pe."entityId"
          WHERE pe."assetId" = a.id AND p.type = 'person' AND p."canonicalName" = '坂井新奈'
        )
        AND EXISTS (
          SELECT 1 FROM "AssetText" t
          WHERE t."assetId" = a.id AND t."textType" = 'body' AND t.content LIKE '%今日の発見%'
        )
        AND NOT EXISTS (
          SELECT 1 FROM "AssetEntity" te JOIN "Entity" tg ON tg.id = te."entityId"
          WHERE te."assetId" = a.id AND tg.type = 'tag' AND tg."canonicalName" = '今日の発見'
        )
      ORDER BY a."canonicalDate" DESC NULLS LAST
      LIMIT ${DETAIL_LIMIT}`;
    const assets = rows.map((r) => ({ id: r.id, title: r.title, date: r.canonicalDate?.toISOString() ?? null }));
    if (assets.length === 0) return { status: "ok", summary: "未抽出なし", detail: { assets } };
    return { status: "warn", summary: `未抽出 ${assets.length} 件`, detail: { assets } };
  },
};

const thumbnailsPending: CheckDefinition = {
  key: "process.thumbnails_pending",
  group: "process",
  name: "サムネイル未生成",
  description: "R2 にサムネイルが無い Drive 上の画像・動画 (pnpm cli:thumbnails の対象と同じ条件)",
  notify: false,
  async run(): Promise<CheckOutcome> {
    if (!isR2Configured() || !process.env.R2_PUBLIC_URL) return { status: "unknown", summary: "R2 未設定", detail: {} };
    const count = await prismaInternal.asset.count({ where: thumbnailPendingWhere() });
    return { status: "ok", summary: count === 0 ? "未生成なし" : `未生成 ${count} 件`, detail: { count } };
  },
};

const inboxBacklog: CheckDefinition = {
  key: "process.inbox_backlog",
  group: "process",
  name: "Inbox 滞留",
  description: "status = inbox のアセット数",
  notify: false,
  async run() {
    const count = await prismaInternal.asset.count({ where: { status: "inbox" } });
    return { status: "ok", summary: `${count} 件`, detail: { count } };
  },
};

// ---------------------------------------------------------------------------
// 記事 (Article は非保護テーブル)
// ---------------------------------------------------------------------------

const articlesDirty: CheckDefinition = {
  key: "articles.dirty",
  group: "articles",
  name: "未 push の記事",
  description: `dirty な記事の件数と最古の編集日。${ARTICLE_DIRTY_MAX_AGE_DAYS} 日以上放置で注意`,
  notify: true,
  async run({ now }) {
    const rows = await prisma.article.findMany({
      where: { dirty: true },
      orderBy: [{ editedAt: "asc" }, { updatedAt: "asc" }],
      take: DETAIL_LIMIT,
      select: { shortId: true, title: true, path: true, editedAt: true, updatedAt: true },
    });
    const count = await prisma.article.count({ where: { dirty: true } });
    const articles = rows.map((a) => ({
      shortId: a.shortId,
      title: a.title || a.path,
      editedAt: a.editedAt?.toISOString() ?? null,
    }));
    if (count === 0) return { status: "ok", summary: "未 push なし", detail: { count, articles } };
    // 取り込み由来の dirty は editedAt が無い (正規化差分だけ) ので updatedAt で代用する
    const oldest = rows.reduce<Date | null>((acc, a) => {
      const d = a.editedAt ?? a.updatedAt;
      return acc == null || d < acc ? d : acc;
    }, null);
    const ageDays = oldest ? (now.getTime() - oldest.getTime()) / 86_400_000 : 0;
    if (ageDays > ARTICLE_DIRTY_MAX_AGE_DAYS) {
      return {
        status: "warn",
        summary: `未 push ${count} 件 (最古 ${Math.floor(ageDays)} 日前)`,
        detail: { count, articles },
      };
    }
    return { status: "ok", summary: `未 push ${count} 件`, detail: { count, articles } };
  },
};

const articlesPending: CheckDefinition = {
  key: "articles.pending",
  group: "articles",
  name: "未反映の紐づけ",
  description: "ArticleSource が pending のまま本文に反映されていない件数",
  notify: false,
  async run() {
    // ArticleSource は保護テーブル。件数と記事 (非保護) しか出さない
    const rows = await prismaInternal.articleSource.groupBy({
      by: ["articleId"],
      where: { status: "pending" },
      _count: { _all: true },
    });
    const count = rows.reduce((n, r) => n + r._count._all, 0);
    if (count === 0) return { status: "ok", summary: "未反映なし", detail: { count, articles: [] } };
    const articles = await prisma.article.findMany({
      where: { id: { in: rows.slice(0, DETAIL_LIMIT).map((r) => r.articleId) } },
      select: { shortId: true, title: true, path: true },
    });
    return {
      status: "ok",
      summary: `未反映 ${count} 件 (${rows.length} 記事)`,
      detail: { count, articles: articles.map((a) => ({ shortId: a.shortId, title: a.title || a.path })) },
    };
  },
};

const articlesGithubDrift: CheckDefinition = {
  key: "articles.github_drift",
  group: "articles",
  name: "GitHub との差",
  description: "GitHub 側 (origin/main) の blob が akashic の取り込み時点 (githubSha) から進んでいる記事",
  notify: true,
  async run(): Promise<CheckOutcome> {
    if (!isGithubConfigured()) return { status: "unknown", summary: "ARTICLES_GITHUB_TOKEN 未設定", detail: {} };
    const head = await getBranchHead();
    const tree = await getTreeBlobs(head.treeSha);
    const articles = await prisma.article.findMany({
      select: { shortId: true, title: true, path: true, githubSha: true },
    });
    const known = new Set(articles.map((a) => a.path));
    // githubSha が無い記事は akashic で作られて未 push のもの。GitHub に無いのは正常
    const changed = articles.filter((a) => {
      const upstream = tree.get(a.path);
      if (a.githubSha == null) return upstream != null;
      return upstream !== a.githubSha;
    });
    // 取り込みは short_id の無い .md も飛ばすが、tree からは分からないので path の規則だけで見る
    const added = [...tree.keys()].filter((p) => isArticlePath(p) && !known.has(p));
    const detail = {
      commitSha: head.commitSha,
      changed: changed.slice(0, DETAIL_LIMIT).map((a) => ({ shortId: a.shortId, title: a.title || a.path, path: a.path })),
      added: added.slice(0, DETAIL_LIMIT),
      changedCount: changed.length,
      addedCount: added.length,
    };
    if (changed.length === 0 && added.length === 0) return { status: "ok", summary: "GitHub と一致", detail };
    const parts = [];
    if (changed.length) parts.push(`GitHub 側が進んだ (または消えた) 記事 ${changed.length} 本`);
    if (added.length) parts.push(`未取り込みの新規 ${added.length} 本`);
    return { status: "warn", summary: `${parts.join(" / ")} → 取り込みが必要`, detail };
  },
};

// ---------------------------------------------------------------------------
// akashic 自身
// ---------------------------------------------------------------------------

/**
 * `prismaInternal` が本当に RLS をバイパスしているかの番犬。
 * `DIRECT_URL` 未設定だと `DATABASE_URL` (app_runtime) に無言でフォールバックし、上のチェックが
 * 全件 0 で「未抽出なし」(fail-open) になる。Asset が 0 件ならその状態とみなして error にする
 */
const internalDbAccess: CheckDefinition = {
  key: "system.internal_db",
  group: "system",
  name: "内部 DB 接続 (prismaInternal)",
  description: "DIRECT_URL 経由で保護テーブルが読めているか (0 件なら RLS に落ちている)",
  notify: true,
  async run() {
    const count = await prismaInternal.asset.count();
    if (count === 0) {
      return { status: "error", summary: "Asset が 0 件。DIRECT_URL 未設定で RLS に落ちている可能性", detail: { count } };
    }
    return { status: "ok", summary: `Asset ${count.toLocaleString("ja-JP")} 件`, detail: { count } };
  },
};

// ---------------------------------------------------------------------------

/**
 * 評価対象のチェック一覧。ハートビートは Job 行に応じて増えるので毎回組み立てる。
 * 並びはグループ順 → 定義順。/status は保存された行を読むので、この並びは cron の応答にだけ出る
 */
export async function getCheckDefinitions(): Promise<CheckDefinition[]> {
  const [freshness, heartbeats] = await Promise.all([sourceFreshnessChecks(), heartbeatChecks()]);
  const all = [
    ...freshness,
    ...heartbeats,
    discoveryUnextracted,
    thumbnailsPending,
    inboxBacklog,
    articlesDirty,
    articlesPending,
    articlesGithubDrift,
    internalDbAccess,
  ];
  return all
    .map((c, i) => ({ c, i }))
    .sort((a, b) => CHECK_GROUPS.indexOf(a.c.group) - CHECK_GROUPS.indexOf(b.c.group) || a.i - b.i)
    .map(({ c }) => c);
}

export type CheckRun = { def: CheckDefinition; outcome: CheckOutcome };

/**
 * 全チェックを並列で走らせる。例外とタイムアウトは握って error にする
 * (GitHub が固まっても他のチェックの保存と通知を止めない)
 */
export async function runAllChecks(ctx: CheckContext): Promise<CheckRun[]> {
  const defs = await getCheckDefinitions();
  return Promise.all(
    defs.map(async (def) => {
      try {
        return { def, outcome: await withTimeout(def.run(ctx), CHECK_TIMEOUT_MS) };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { def, outcome: { status: "error" as const, summary: `評価に失敗: ${message}`, detail: {} } };
      }
    }),
  );
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${ms / 1000} 秒以内に終わりませんでした`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
