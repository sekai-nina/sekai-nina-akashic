-- 本文の版 (#262)。
--
-- 公式ブログは公開後に本文が直されることがある。今の取り込みは最初の 1 回だけで、取り直すと
-- 上書きになって元の版が消える。bot が毎日公式と突き合わせ、本文が違っていたら版を積む。
-- AssetText は常に最新版のまま (検索・記事化は無改修)。過去の版はこのテーブルに残す。
-- RLS は親 Asset の classification に従う (AssetText と同形)。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "AssetTextRevision" TO app_runtime;

CREATE TABLE "AssetTextRevision" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "assetTextId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetTextRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AssetTextRevision_assetId_idx" ON "AssetTextRevision"("assetId");

CREATE UNIQUE INDEX "AssetTextRevision_assetTextId_version_key" ON "AssetTextRevision"("assetTextId", "version");

ALTER TABLE "AssetTextRevision" ADD CONSTRAINT "AssetTextRevision_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssetTextRevision" ADD CONSTRAINT "AssetTextRevision_assetTextId_fkey" FOREIGN KEY ("assetTextId") REFERENCES "AssetText"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS
ALTER TABLE "AssetTextRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetTextRevision" FORCE ROW LEVEL SECURITY;

CREATE POLICY assettextrevision_select ON "AssetTextRevision" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetTextRevision"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY assettextrevision_insert ON "AssetTextRevision" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetTextRevision"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY assettextrevision_update ON "AssetTextRevision" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetTextRevision"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetTextRevision"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY assettextrevision_delete ON "AssetTextRevision" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetTextRevision"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
