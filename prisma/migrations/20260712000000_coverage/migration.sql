-- 収集カバレッジ管理 (観点 × データソース)
-- Lens / DataSource / Coverage の3モデル＋2 enum を追加。
-- 3 テーブルとも classification を持ち、RLS は Place/RepoCollection と同じ
-- direct-classification パターンを本 migration 内で必ず張る（過去に RLS 忘れで
-- PostgREST 公開事故があったため絶対条件）。clearance_rank() は
-- 20260511000000_add_rls 定義。

-- CreateEnum
CREATE TYPE "DataSourceKind" AS ENUM ('blog', 'talk', 'tv', 'youtube', 'sns', 'radio', 'magazine', 'live_event', 'other');

-- CreateEnum
CREATE TYPE "CoverageStatus" AS ENUM ('tracked', 'not_applicable');

-- CreateTable
CREATE TABLE "Lens" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "public" BOOLEAN NOT NULL DEFAULT true,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSource" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "DataSourceKind" NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "public" BOOLEAN NOT NULL DEFAULT true,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coverage" (
    "id" TEXT NOT NULL,
    "lensId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "status" "CoverageStatus" NOT NULL DEFAULT 'tracked',
    "collectedUntil" TIMESTAMP(3),
    "note" TEXT,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Coverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lens_key_key" ON "Lens"("key");

-- CreateIndex
CREATE INDEX "Lens_classification_idx" ON "Lens"("classification");

-- CreateIndex
CREATE UNIQUE INDEX "DataSource_key_key" ON "DataSource"("key");

-- CreateIndex
CREATE INDEX "DataSource_classification_idx" ON "DataSource"("classification");

-- CreateIndex
CREATE INDEX "Coverage_dataSourceId_idx" ON "Coverage"("dataSourceId");

-- CreateIndex
CREATE INDEX "Coverage_classification_idx" ON "Coverage"("classification");

-- CreateIndex
CREATE UNIQUE INDEX "Coverage_lensId_dataSourceId_key" ON "Coverage"("lensId", "dataSourceId");

-- AddForeignKey
ALTER TABLE "Coverage" ADD CONSTRAINT "Coverage_lensId_fkey" FOREIGN KEY ("lensId") REFERENCES "Lens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coverage" ADD CONSTRAINT "Coverage_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS (clearance ベース、fail-closed)。clearance_rank() は 20260511000000_add_rls 定義。
-- Lens / DataSource / Coverage はいずれも自身の classification を clearance で判定する
-- direct-classification パターン（Asset/Place/RepoCollection と同形）。
-- app_runtime ロールに対し set_config('app.clearance', ...) を要求する。
-- ============================================================

-- Lens
ALTER TABLE "Lens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Lens" FORCE  ROW LEVEL SECURITY;

CREATE POLICY lens_select ON "Lens" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY lens_insert ON "Lens" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY lens_update ON "Lens" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY lens_delete ON "Lens" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);

-- DataSource
ALTER TABLE "DataSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DataSource" FORCE  ROW LEVEL SECURITY;

CREATE POLICY datasource_select ON "DataSource" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY datasource_insert ON "DataSource" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY datasource_update ON "DataSource" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY datasource_delete ON "DataSource" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);

-- Coverage
ALTER TABLE "Coverage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Coverage" FORCE  ROW LEVEL SECURITY;

CREATE POLICY coverage_select ON "Coverage" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY coverage_insert ON "Coverage" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY coverage_update ON "Coverage" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY coverage_delete ON "Coverage" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
