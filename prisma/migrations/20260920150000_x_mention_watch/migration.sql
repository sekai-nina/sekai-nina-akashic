-- X 言及監視 (#142)
--
-- 監視語 (X の検索クエリ) ごとに毎日 recent search し、除外ユーザー以外の投稿を Discord に流す。
--
--   - XMentionWatch:   監視語。複数行。lastTweetId が次回の since_id (null なら初回 = 直近 24 時間)
--   - XMentionSetting: 除外ユーザー名。全監視語で共通なので行は 1 つだけ (id = 'singleton')
--   - XMentionHit:     拾ったツイート。監視語ごとに 1 行 (watchId, tweetId で unique)。
--                      notifiedAt が null のものは次回の実行で Discord に再送する
--
-- 3 テーブルとも direct-classification パターンの RLS (既定 internal)。cron はセッション外で
-- 走るので prismaInternal で触り、/mentions は withClearance で読む。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "XMentionWatch", "XMentionSetting", "XMentionHit" TO app_runtime;

-- CreateTable
CREATE TABLE "XMentionWatch" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastTweetId" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XMentionWatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XMentionSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "excludedUsernames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',

    CONSTRAINT "XMentionSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XMentionHit" (
    "id" TEXT NOT NULL,
    "watchId" TEXT NOT NULL,
    "tweetId" TEXT NOT NULL,
    "authorUsername" TEXT NOT NULL,
    "authorName" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL,
    "tweetedAt" TIMESTAMP(3),
    "url" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XMentionHit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "XMentionWatch_classification_idx" ON "XMentionWatch"("classification");

-- CreateIndex
CREATE INDEX "XMentionHit_tweetId_idx" ON "XMentionHit"("tweetId");

-- CreateIndex
CREATE INDEX "XMentionHit_createdAt_idx" ON "XMentionHit"("createdAt");

-- CreateIndex
CREATE INDEX "XMentionHit_classification_idx" ON "XMentionHit"("classification");

-- CreateIndex
CREATE UNIQUE INDEX "XMentionHit_watchId_tweetId_key" ON "XMentionHit"("watchId", "tweetId");

-- AddForeignKey
ALTER TABLE "XMentionSetting" ADD CONSTRAINT "XMentionSetting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XMentionHit" ADD CONSTRAINT "XMentionHit_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "XMentionWatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS (clearance ベース、fail-closed)。clearance_rank() は 20260511000000_add_rls 定義。
ALTER TABLE "XMentionWatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "XMentionWatch" FORCE  ROW LEVEL SECURITY;

CREATE POLICY xmentionwatch_select ON "XMentionWatch" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY xmentionwatch_insert ON "XMentionWatch" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY xmentionwatch_update ON "XMentionWatch" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY xmentionwatch_delete ON "XMentionWatch" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);

ALTER TABLE "XMentionSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "XMentionSetting" FORCE  ROW LEVEL SECURITY;

CREATE POLICY xmentionsetting_select ON "XMentionSetting" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY xmentionsetting_insert ON "XMentionSetting" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY xmentionsetting_update ON "XMentionSetting" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY xmentionsetting_delete ON "XMentionSetting" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);

ALTER TABLE "XMentionHit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "XMentionHit" FORCE  ROW LEVEL SECURITY;

CREATE POLICY xmentionhit_select ON "XMentionHit" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY xmentionhit_insert ON "XMentionHit" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY xmentionhit_update ON "XMentionHit" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY xmentionhit_delete ON "XMentionHit" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
