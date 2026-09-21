-- TikTok の監視対象と見えた動画の台帳 (#179)
--
-- 公式 TikTok (@hinatazakanews) を bot (tiktok-watch) が巡回し、新着を DL して akashic に
-- 登録する。Instagram (InstaWatchTarget) と同じく対象は画面から編集するが、TikTok は
-- 「どの動画を取ったか」の台帳も akashic 側に置く (TiktokVideo)。bot は見えた動画を報告し、
-- akashic が「これを DL して」と返す。bot の state を失っても二重登録・二重通知しない。
--
-- 両テーブルとも保護テーブル (classification 既定 internal)。RLS は他の保護テーブルと同形。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "TiktokWatchTarget" TO app_runtime;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "TiktokVideo" TO app_runtime;

-- CreateEnum
CREATE TYPE "TiktokVideoStatus" AS ENUM ('skipped_initial', 'pending', 'registered', 'failed');

-- CreateTable
CREATE TABLE "TiktokWatchTarget" (
    "id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL DEFAULT '',
    "official" BOOLEAN NOT NULL DEFAULT true,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 30,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT NOT NULL DEFAULT '',
    "secUid" TEXT,
    "videoCount" INTEGER,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',

    CONSTRAINT "TiktokWatchTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TiktokVideo" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "createTime" TIMESTAMP(3) NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "durationSec" INTEGER,
    "coverUrl" TEXT,
    "status" "TiktokVideoStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT NOT NULL DEFAULT '',
    "assetId" TEXT,
    "registeredAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',

    CONSTRAINT "TiktokVideo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TiktokWatchTarget_handle_key" ON "TiktokWatchTarget"("handle");
CREATE INDEX "TiktokWatchTarget_enabled_idx" ON "TiktokWatchTarget"("enabled");
CREATE UNIQUE INDEX "TiktokVideo_videoId_key" ON "TiktokVideo"("videoId");
CREATE UNIQUE INDEX "TiktokVideo_assetId_key" ON "TiktokVideo"("assetId");
CREATE INDEX "TiktokVideo_targetId_status_idx" ON "TiktokVideo"("targetId", "status");
CREATE INDEX "TiktokVideo_createTime_idx" ON "TiktokVideo"("createTime");
CREATE INDEX "TiktokVideo_classification_idx" ON "TiktokVideo"("classification");

-- AddForeignKey
ALTER TABLE "TiktokWatchTarget" ADD CONSTRAINT "TiktokWatchTarget_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TiktokVideo" ADD CONSTRAINT "TiktokVideo_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TiktokWatchTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TiktokVideo" ADD CONSTRAINT "TiktokVideo_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS (他の保護テーブルと同形。clearance_rank() は 20260511000000_add_rls で定義済み)
ALTER TABLE "TiktokWatchTarget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TiktokWatchTarget" FORCE ROW LEVEL SECURITY;

CREATE POLICY tiktokwatchtarget_select ON "TiktokWatchTarget" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY tiktokwatchtarget_insert ON "TiktokWatchTarget" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY tiktokwatchtarget_update ON "TiktokWatchTarget" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY tiktokwatchtarget_delete ON "TiktokWatchTarget" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);

ALTER TABLE "TiktokVideo" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TiktokVideo" FORCE ROW LEVEL SECURITY;

CREATE POLICY tiktokvideo_select ON "TiktokVideo" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY tiktokvideo_insert ON "TiktokVideo" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY tiktokvideo_update ON "TiktokVideo" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY tiktokvideo_delete ON "TiktokVideo" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
