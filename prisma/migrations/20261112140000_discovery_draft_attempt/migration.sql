-- 今日の発見の下書きを cron が試した記録 (#432)。
-- Claude が下書きを返さない・失敗し続けるブログを、15 分 cron が 30 日間やり直し続けないよう (最悪 $200 超)、
-- ブログごとに試した回数と最後の失敗理由を残し、上限で cron の対象から外す (FaceScan と同じ考え方)。
-- DiscoveryDraftAttempt: ブログ 1 本に 1 行 (assetId が主キー)。
-- 保護テーブル。自前の classification は持たず、親 Asset の classification で RLS を効かせる (AssetEntity と同じ形)。
-- 本番未適用。ユーザーの承認後に適用する。
-- ⚠ 本番適用後の手動 GRANT が必要 (既定権限で付いていれば不要。has_table_privilege で確かめる):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "DiscoveryDraftAttempt" TO app_runtime;
-- 参考: 先に当てた Discovery / DiscoveryFood (20261112100000 / 20261112110000) は、2026-11-12 の本番適用時に
-- app_runtime / app_internal / akashic_cli とも既定権限で SELECT / INSERT が付いていたのを確かめた
-- (DiscoveryFood は anon / authenticated にも付いていたが、ポリシーが無いので 0 行)。

-- CreateTable
CREATE TABLE "DiscoveryDraftAttempt" (
    "assetId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastTriedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryDraftAttempt_pkey" PRIMARY KEY ("assetId")
);

-- AddForeignKey
ALTER TABLE "DiscoveryDraftAttempt" ADD CONSTRAINT "DiscoveryDraftAttempt_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: 親 Asset の classification に従う
ALTER TABLE "DiscoveryDraftAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscoveryDraftAttempt" FORCE ROW LEVEL SECURITY;

CREATE POLICY discoverydraftattempt_select ON "DiscoveryDraftAttempt" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "DiscoveryDraftAttempt"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY discoverydraftattempt_insert ON "DiscoveryDraftAttempt" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "DiscoveryDraftAttempt"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY discoverydraftattempt_update ON "DiscoveryDraftAttempt" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Asset" WHERE id = "DiscoveryDraftAttempt"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Asset" WHERE id = "DiscoveryDraftAttempt"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY discoverydraftattempt_delete ON "DiscoveryDraftAttempt" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "DiscoveryDraftAttempt"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
