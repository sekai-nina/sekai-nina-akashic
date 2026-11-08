-- 顔認識の結果 (#384)。推論は sekai-nina-omokage のワーカーが行い、API で書き込む。
-- FaceDetection: 検出した顔 1 つ (枠・特徴量・推定したメンバー・状態)
-- FaceScan: どの画像をどのモデルで処理したか (顔が 0 個の画像・処理できなかった画像を何度も queue に出さないため)
-- どちらも保護テーブル。自前の classification は持たず、親 Asset の classification で RLS を効かせる (AssetEntity と同じ形)。
-- 本番未適用。ユーザーの承認後に適用する。
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "FaceDetection" TO app_runtime;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "FaceScan" TO app_runtime;
-- CreateEnum
CREATE TYPE "FaceStatus" AS ENUM ('auto', 'pending', 'confirmed', 'rejected');

-- CreateTable
CREATE TABLE "FaceDetection" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "x1" DOUBLE PRECISION NOT NULL,
    "y1" DOUBLE PRECISION NOT NULL,
    "x2" DOUBLE PRECISION NOT NULL,
    "y2" DOUBLE PRECISION NOT NULL,
    "detScore" DOUBLE PRECISION NOT NULL,
    "embedding" BYTEA NOT NULL,
    "predictedEntityId" TEXT,
    "similarity" DOUBLE PRECISION,
    "status" "FaceStatus" NOT NULL,
    "confirmedEntityId" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaceDetection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaceScan" (
    "assetId" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "faceCount" INTEGER NOT NULL,
    "error" TEXT,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaceScan_pkey" PRIMARY KEY ("assetId","modelVersion")
);

-- CreateIndex
CREATE INDEX "FaceDetection_assetId_idx" ON "FaceDetection"("assetId");

-- CreateIndex
CREATE INDEX "FaceDetection_status_idx" ON "FaceDetection"("status");

-- CreateIndex
CREATE INDEX "FaceDetection_predictedEntityId_idx" ON "FaceDetection"("predictedEntityId");

-- CreateIndex
CREATE INDEX "FaceDetection_confirmedEntityId_idx" ON "FaceDetection"("confirmedEntityId");

-- CreateIndex
CREATE INDEX "FaceScan_modelVersion_idx" ON "FaceScan"("modelVersion");

-- AddForeignKey
ALTER TABLE "FaceDetection" ADD CONSTRAINT "FaceDetection_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaceDetection" ADD CONSTRAINT "FaceDetection_predictedEntityId_fkey" FOREIGN KEY ("predictedEntityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaceDetection" ADD CONSTRAINT "FaceDetection_confirmedEntityId_fkey" FOREIGN KEY ("confirmedEntityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaceDetection" ADD CONSTRAINT "FaceDetection_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaceScan" ADD CONSTRAINT "FaceScan_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- RLS: 親 Asset の classification で絞る
ALTER TABLE "FaceDetection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FaceDetection" FORCE ROW LEVEL SECURITY;

CREATE POLICY facedetection_select ON "FaceDetection" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "FaceDetection"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY facedetection_insert ON "FaceDetection" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "FaceDetection"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY facedetection_update ON "FaceDetection" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Asset" WHERE id = "FaceDetection"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Asset" WHERE id = "FaceDetection"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY facedetection_delete ON "FaceDetection" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "FaceDetection"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));

-- RLS: 親 Asset の classification で絞る
ALTER TABLE "FaceScan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FaceScan" FORCE ROW LEVEL SECURITY;

CREATE POLICY facescan_select ON "FaceScan" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "FaceScan"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY facescan_insert ON "FaceScan" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "FaceScan"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY facescan_update ON "FaceScan" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Asset" WHERE id = "FaceScan"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Asset" WHERE id = "FaceScan"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY facescan_delete ON "FaceScan" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "FaceScan"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
