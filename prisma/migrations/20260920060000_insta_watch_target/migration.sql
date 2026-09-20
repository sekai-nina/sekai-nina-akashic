-- insta-watch が見張る Instagram のハンドルを画面から管理できるようにする。
--
-- これまで監視対象は bot サーバの config/accounts.txt にしか無く、変えるには ssh が要った。
-- 「誰を見ているか」は運用判断なので Akashic 側に持たせ、bot は API から読む。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "InstaWatchTarget" TO app_runtime;

CREATE TYPE "InstaWatchTier" AS ENUM ('hot', 'normal', 'cold');

CREATE TABLE "InstaWatchTarget" (
    "id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "tier" "InstaWatchTier" NOT NULL DEFAULT 'normal',
    "intervalMinutes" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    CONSTRAINT "InstaWatchTarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InstaWatchTarget_handle_key" ON "InstaWatchTarget"("handle");
CREATE INDEX "InstaWatchTarget_enabled_idx" ON "InstaWatchTarget"("enabled");

ALTER TABLE "InstaWatchTarget" ADD CONSTRAINT "InstaWatchTarget_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS (clearance_rank は 20260511000000_add_rls で定義済み)
ALTER TABLE "InstaWatchTarget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InstaWatchTarget" FORCE ROW LEVEL SECURITY;

CREATE POLICY insta_watch_target_select ON "InstaWatchTarget" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY insta_watch_target_insert ON "InstaWatchTarget" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY insta_watch_target_update ON "InstaWatchTarget" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY insta_watch_target_delete ON "InstaWatchTarget" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
