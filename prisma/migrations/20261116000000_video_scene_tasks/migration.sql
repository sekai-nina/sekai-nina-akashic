-- #394: 場面候補と、スマホに保存する範囲の書き出し依頼。
-- 元動画の現在の classification を 4 操作の RLS で確認する。
-- 本番未適用。承認後に適用する。
-- ⚠ 本番適用後の手動 GRANT:
-- GRANT SELECT, INSERT, UPDATE, DELETE ON "VideoSceneTask" TO app_runtime;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON "VideoSceneFile" TO app_runtime;
CREATE TABLE "VideoSceneTask" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "assetId" TEXT NOT NULL REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "requestKey" TEXT NOT NULL UNIQUE,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('analyze', 'export')),
  "status" TEXT NOT NULL DEFAULT 'queued' CHECK ("status" IN ('queued', 'processing', 'ready', 'failed')),
  "startSec" DOUBLE PRECISION,
  "endSec" DOUBLE PRECISION,
  "result" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "requestedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VideoSceneTask_range_check" CHECK (
    ("kind" = 'analyze' AND "startSec" IS NULL AND "endSec" IS NULL) OR
    ("kind" = 'export' AND "startSec" IS NOT NULL AND "endSec" IS NOT NULL AND "startSec" >= 0 AND "endSec" > "startSec" AND "endSec" - "startSec" <= 90)
  )
);
CREATE INDEX "VideoSceneTask_assetId_kind_createdAt_idx" ON "VideoSceneTask"("assetId", "kind", "createdAt");
CREATE INDEX "VideoSceneTask_status_createdAt_idx" ON "VideoSceneTask"("status", "createdAt");
ALTER TABLE "VideoSceneTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VideoSceneTask" FORCE ROW LEVEL SECURITY;
CREATE POLICY videoscenetask_select ON "VideoSceneTask" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "VideoSceneTask"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY videoscenetask_insert ON "VideoSceneTask" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "VideoSceneTask"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY videoscenetask_update ON "VideoSceneTask" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Asset" WHERE id = "VideoSceneTask"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Asset" WHERE id = "VideoSceneTask"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY videoscenetask_delete ON "VideoSceneTask" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "VideoSceneTask"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));

CREATE TABLE "VideoSceneFile" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL REFERENCES "VideoSceneTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "slot" TEXT NOT NULL,
  "storageKey" TEXT,
  "filename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL CHECK ("mimeType" IN ('image/jpeg', 'video/mp4')),
  "fileSize" INTEGER CHECK ("fileSize" > 0 AND "fileSize" <= 100000000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("taskId", "slot")
);
ALTER TABLE "VideoSceneFile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VideoSceneFile" FORCE ROW LEVEL SECURITY;
CREATE POLICY videoscenefile_select ON "VideoSceneFile" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "VideoSceneTask" WHERE id = "VideoSceneFile"."taskId"));
CREATE POLICY videoscenefile_insert ON "VideoSceneFile" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "VideoSceneTask" WHERE id = "VideoSceneFile"."taskId"));
CREATE POLICY videoscenefile_update ON "VideoSceneFile" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "VideoSceneTask" WHERE id = "VideoSceneFile"."taskId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "VideoSceneTask" WHERE id = "VideoSceneFile"."taskId"));
CREATE POLICY videoscenefile_delete ON "VideoSceneFile" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "VideoSceneTask" WHERE id = "VideoSceneFile"."taskId"));
