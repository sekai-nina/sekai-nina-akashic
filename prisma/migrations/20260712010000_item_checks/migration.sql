-- 収集カバレッジ v2 — アイテム単位チェック
-- v1 の日付カーソル (Coverage.collectedUntil) を廃止し、チェックの最小単位を
-- 「ソースごとのアイテム（ブログ記事1本・トーク1日分・番組回1つ）」にする。
-- アイテムはテーブル実体化せず SourceRecord/Asset から導出（itemRule で規則を持つ）。
--
-- 変更内容:
--   1. ItemRule enum
--   2. DataSource へ itemRule / publisherPattern / titlePattern を追加
--   3. LensItemCheck 新設（RLS 込み・direct-classification）
--   4. Coverage.collectedUntil を DROP（セルは not_applicable / note 専用に格下げ）
--
-- LensItemCheck の RLS は Lens/DataSource/Coverage(20260712000000_coverage) と同形の
-- direct-classification パターンを本 migration 内で必ず張る（RLS 忘れの公開事故防止）。
-- clearance_rank() は 20260511000000_add_rls 定義。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "LensItemCheck" TO app_runtime;

-- CreateEnum
CREATE TYPE "ItemRule" AS ENUM ('blog_url', 'talk_date', 'source_url', 'manual');

-- AlterTable: DataSource にアイテム導出規則を追加
ALTER TABLE "DataSource"
  ADD COLUMN "itemRule" "ItemRule" NOT NULL DEFAULT 'manual',
  ADD COLUMN "publisherPattern" TEXT,
  ADD COLUMN "titlePattern" TEXT;

-- CreateTable: LensItemCheck（「このアイテムをこの観点で見た」の記録）
CREATE TABLE "LensItemCheck" (
    "id" TEXT NOT NULL,
    "lensId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "itemDate" TIMESTAMP(3),
    "itemTitle" TEXT,
    "note" TEXT,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "checkedById" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LensItemCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LensItemCheck_lensId_dataSourceId_itemKey_key" ON "LensItemCheck"("lensId", "dataSourceId", "itemKey");

-- CreateIndex
CREATE INDEX "LensItemCheck_dataSourceId_itemDate_idx" ON "LensItemCheck"("dataSourceId", "itemDate");

-- CreateIndex
CREATE INDEX "LensItemCheck_classification_idx" ON "LensItemCheck"("classification");

-- AddForeignKey
ALTER TABLE "LensItemCheck" ADD CONSTRAINT "LensItemCheck_lensId_fkey" FOREIGN KEY ("lensId") REFERENCES "Lens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LensItemCheck" ADD CONSTRAINT "LensItemCheck_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS (clearance ベース、fail-closed)。clearance_rank() は 20260511000000_add_rls 定義。
-- LensItemCheck は自身の classification を clearance で判定する direct-classification
-- パターン（Lens/DataSource/Coverage と同形）。app_runtime に set_config('app.clearance', ...) を要求。
-- ============================================================

ALTER TABLE "LensItemCheck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LensItemCheck" FORCE  ROW LEVEL SECURITY;

CREATE POLICY lensitemcheck_select ON "LensItemCheck" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY lensitemcheck_insert ON "LensItemCheck" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY lensitemcheck_update ON "LensItemCheck" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY lensitemcheck_delete ON "LensItemCheck" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);

-- ============================================================
-- v1 日付カーソルの廃止: Coverage.collectedUntil を DROP。
-- 本番の Coverage は 0 件（セル未作成）のため破壊なし。
-- ============================================================
ALTER TABLE "Coverage" DROP COLUMN "collectedUntil";
