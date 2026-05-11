import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  basePrisma: PrismaClient;
  internalPrisma: PrismaClient;
};

/**
 * Runtime Prisma client — connects as `app_runtime` via DATABASE_URL.
 * RLS is enforced: without set_config('app.clearance', ...), all Asset
 * and related table queries return 0 rows (fail-closed).
 */
const basePrisma = globalForPrisma.basePrisma || new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.basePrisma = basePrisma;

/**
 * Internal Prisma client — connects as `postgres` via DIRECT_URL.
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
 * Execute a function within a transaction with RLS clearance set.
 * All queries through `tx` will be filtered by the user's clearance level.
 *
 * This is the primary way to access protected data (Asset and related tables).
 * Without this wrapper, all protected table queries return 0 rows.
 */
export async function withClearance<T>(
  clearance: string,
  fn: (tx: TransactionClient) => Promise<T>
): Promise<T> {
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.clearance', ${clearance}, true)`;
    return fn(tx);
  });
}

export const prisma = basePrisma;
export { internalPrisma as prismaInternal };
