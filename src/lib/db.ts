import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  basePrisma: PrismaClient;
  internalPrisma: PrismaClient;
};

/**
 * 接続プールの既定の大きさ。URL に `connection_limit` が無いと Prisma は「物理 CPU 数 × 2 + 1」
 * (Vercel の関数では 3〜5 本) にする。アセット詳細のように 1 画面で 10 本前後のトランザクションを
 * 並べて張るページでは、残りが接続の空き待ちで順番に並んでしまう (#299 の並列化が効き切らない)。
 * 接続先は Supabase の pooler (6543, transaction mode) なので、クライアント側の本数を増やしても
 * DB の実接続はプールが束ねる。Prisma は要る分だけ開くので、暇なインスタンスが 10 本を抱えることはない。
 * 同じインスタンスに来た同時リクエスト (プリフェッチを含む) はこの 10 本を分け合う。
 * URL に明示してあればそちらを優先する。
 */
const RUNTIME_CONNECTION_LIMIT = 10;

function runtimeDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", String(RUNTIME_CONNECTION_LIMIT));
    }
    return url.toString();
  } catch {
    return raw;
  }
}

/**
 * Runtime Prisma client — connects as `app_runtime` via DATABASE_URL.
 * RLS is enforced: without set_config('app.clearance', ...), all Asset
 * and related table queries return 0 rows (fail-closed).
 */
const basePrisma =
  globalForPrisma.basePrisma || new PrismaClient({ datasources: { db: { url: runtimeDatabaseUrl() } } });
if (process.env.NODE_ENV !== "production") globalForPrisma.basePrisma = basePrisma;

/**
 * Internal Prisma client — connects via DIRECT_URL (`app_internal` on Vercel, `akashic_cli` locally; no DDL).
 * Bypasses RLS. Only for CLI, bot, migrations, and internal stats.
 */
const internalPrisma =
  globalForPrisma.internalPrisma ||
  new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
if (process.env.NODE_ENV !== "production") globalForPrisma.internalPrisma = internalPrisma;

/**
 * Transaction client type for use with withClearance.
 */
export type TransactionClient = Parameters<
  Parameters<typeof basePrisma.$transaction>[0]
>[0];

/**
 * Interactive transaction options. Prisma の既定タイムアウトは 5000ms で、
 * ローカル→Supabase のレイテンシ込みの重い集約（例: ブログ導出 13.9k SourceRecord）で
 * P2028 (Transaction already closed) になるため、既定を 15s に引き上げる。
 * 接続待ち (maxWait) も既定 2000ms から引き上げる（DEFAULT_TX_MAX_WAIT_MS）。
 */
export interface TxOptions {
  timeout?: number; // ms
  maxWait?: number; // ms
}

const DEFAULT_TX_TIMEOUT_MS = 15_000;

/**
 * プールから接続を取るまでの待ち時間。Prisma 既定の 2000ms だと、/coverage の
 * ソース別導出のように tx を並列に張る経路で接続待ちがあふれて
 * P2028 (Unable to start a transaction in the given time) になるため引き上げる。
 */
const DEFAULT_TX_MAX_WAIT_MS = 10_000;

/**
 * これより長くかかったトランザクションは Vercel のログに `[slow-tx]` で出す。
 * 接続待ち (maxWait) を含めた所要時間。どこから呼ばれたかは呼び出し時のスタックで分かる。
 * 計り方と直し方は docs/performance.md。
 */
const SLOW_TX_MS = 1_000;

async function logIfSlow<T>(run: () => Promise<T>): Promise<T> {
  // スタックの文字列化は参照したときにだけ走るので、遅くなかったときの負担は Error の生成 (とスタックの記録) だけ
  const origin = new Error("slow-tx");
  const start = performance.now();
  try {
    return await run();
  } finally {
    const ms = performance.now() - start;
    if (ms >= SLOW_TX_MS) {
      const caller = origin.stack?.split("\n").slice(3, 7).map((l) => l.trim()).join(" <- ");
      console.warn(`[slow-tx] ${Math.round(ms)}ms ${caller ?? ""}`);
    }
  }
}

/**
 * Execute a function within a transaction with RLS clearance set.
 * All queries through `tx` will be filtered by the user's clearance level.
 *
 * This is the primary way to access protected data (Asset and related tables).
 * Without this wrapper, all protected table queries return 0 rows.
 */
export async function withClearance<T>(
  clearance: string,
  fn: (tx: TransactionClient) => Promise<T>,
  opts?: TxOptions
): Promise<T> {
  return logIfSlow(() =>
    basePrisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.clearance', ${clearance}, true)`;
        return fn(tx);
      },
      {
        timeout: opts?.timeout ?? DEFAULT_TX_TIMEOUT_MS,
        maxWait: opts?.maxWait ?? DEFAULT_TX_MAX_WAIT_MS,
      }
    )
  );
}

/**
 * Like withClearance, but also exposes the acting user's id via the
 * `app.user_id` PostgreSQL session variable. Required for tables whose
 * RLS policies need owner-based rules in addition to clearance — currently
 * Dossier, DossierItem, DossierPlaceCandidate.
 */
export async function withSession<T>(
  user: { id: string; clearance: string },
  fn: (tx: TransactionClient) => Promise<T>,
  opts?: TxOptions
): Promise<T> {
  return logIfSlow(() =>
    basePrisma.$transaction(
      async (tx) => {
        // 2 つを 1 文で設定する (1 文ずつだと withSession のたびに往復が 1 回増える)
        await tx.$executeRaw`SELECT set_config('app.user_id', ${user.id}, true), set_config('app.clearance', ${user.clearance}, true)`;
        return fn(tx);
      },
      {
        timeout: opts?.timeout ?? DEFAULT_TX_TIMEOUT_MS,
        maxWait: opts?.maxWait ?? DEFAULT_TX_MAX_WAIT_MS,
      }
    )
  );
}

export const prisma = basePrisma;
export { internalPrisma as prismaInternal };
