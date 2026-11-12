-- 今日の発見の食べ物ごとのイラストのアイコン (#436)。
-- DiscoveryFood は classification を持たない非保護テーブル (RLS は USING (true) で素通し)。
-- 既にあるテーブルへの列の追加だけなので、app_runtime への GRANT は追加で要らない。
ALTER TABLE "DiscoveryFood" ADD COLUMN "iconKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "DiscoveryFood" ADD COLUMN "iconNote" TEXT NOT NULL DEFAULT '';
ALTER TABLE "DiscoveryFood" ADD COLUMN "iconFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DiscoveryFood" ADD COLUMN "iconUpdatedAt" TIMESTAMP(3);
