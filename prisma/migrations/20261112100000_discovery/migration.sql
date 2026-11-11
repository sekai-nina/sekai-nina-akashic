-- 今日の発見を発見 1 件ごとに持つ (#432)。サイトの「今日の発見ノート」(材料・できあがる味から逆引きするページ) と一覧記事の正。
-- これまでは今日の発見タグ付きのブログ 1 本に annotation (見出し) / extracted (本文の抜粋) が 1 つずつで、
-- 1 本のブログに発見が 2 つある回 (2026-02「きょう！」の 充電 / いちご×醤油) を 2 件に数えられなかった。
-- Discovery: 発見 1 件 (見出し・抜粋・食べ物か・材料・できあがる味・確信度)。1 アセットに複数行 (position)。
-- 保護テーブル。自前の classification は持たず、親 Asset の classification で RLS を効かせる (AssetEntity と同じ形)。
-- 本番未適用。ユーザーの承認後に適用する。
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "Discovery" TO app_runtime;

-- CreateEnum
CREATE TYPE "DiscoveryConfidence" AS ENUM ('certain', 'maybe', 'hearsay');

-- CreateTable
CREATE TABLE "Discovery" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "heading" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "isFood" BOOLEAN NOT NULL,
    "ingredients" TEXT[],
    "result" TEXT,
    "confidence" "DiscoveryConfidence" NOT NULL,
    "draftModel" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Discovery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Discovery_assetId_position_key" ON "Discovery"("assetId", "position");

-- AddForeignKey
ALTER TABLE "Discovery" ADD CONSTRAINT "Discovery_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: 親 Asset の classification に従う
ALTER TABLE "Discovery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Discovery" FORCE ROW LEVEL SECURITY;

CREATE POLICY discovery_select ON "Discovery" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "Discovery"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY discovery_insert ON "Discovery" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "Discovery"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY discovery_update ON "Discovery" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Asset" WHERE id = "Discovery"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Asset" WHERE id = "Discovery"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY discovery_delete ON "Discovery" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "Discovery"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
