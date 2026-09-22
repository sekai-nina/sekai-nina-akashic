-- story を iPad ワーカーに取りに行かせるジョブ (#178)。
--
-- story の実体はサーバから自動取得できない (内部 API は 429、/stories/ は scraping_warning に
-- 飛ぶ)。iPad 上のログイン済み環境 (Shortcuts の「Instagram Download」) なら落とせるので、
-- Akashic がジョブを持ち、Pushcut で iPad のラッパー Shortcut を起こし、落としたファイルを
-- 返してもらう。状態は pending → dispatched → processing → completed | failed。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "InstaStoryJob" TO app_runtime;

CREATE TYPE "InstaStoryJobStatus" AS ENUM ('pending', 'dispatched', 'processing', 'completed', 'failed');

CREATE TABLE "InstaStoryJob" (
    "id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "InstaStoryJobStatus" NOT NULL DEFAULT 'pending',
    "dispatchedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" TEXT NOT NULL DEFAULT '',
    "result" JSONB NOT NULL DEFAULT '{"files":[]}',
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    CONSTRAINT "InstaStoryJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InstaStoryJob_status_createdAt_idx" ON "InstaStoryJob"("status", "createdAt");
CREATE INDEX "InstaStoryJob_handle_createdAt_idx" ON "InstaStoryJob"("handle", "createdAt");
CREATE INDEX "InstaStoryJob_createdAt_idx" ON "InstaStoryJob"("createdAt");

ALTER TABLE "InstaStoryJob" ADD CONSTRAINT "InstaStoryJob_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS (clearance_rank は 20260511000000_add_rls で定義済み)
ALTER TABLE "InstaStoryJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InstaStoryJob" FORCE ROW LEVEL SECURITY;

CREATE POLICY insta_story_job_select ON "InstaStoryJob" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY insta_story_job_insert ON "InstaStoryJob" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY insta_story_job_update ON "InstaStoryJob" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY insta_story_job_delete ON "InstaStoryJob" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
