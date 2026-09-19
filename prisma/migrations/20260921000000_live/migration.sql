-- ライブ (公演) 記事ワークフローの器 Live / LivePerformance / Song / LiveSong を足す (#148 / #149)
--
-- ミーグリ (MeetGreet) と同じ形で、1 つのライブ (ツアー) につき Live 1 行。素材置き場の Dossier
-- (1:1、作成時に自動生成)・X レポの RepoCollection・生成した Article を束ね、公演 (LivePerformance)
-- と披露曲 (LiveSong → Song) を持つ。記事は「1 記事 = 1 ライブ」で、公演は本文の表になる。
--
--   - LivePerformance.date は JST の "YYYY-MM-DD" 文字列 (MeetGreet.date と同じ TZ 事故回避)
--   - LiveSong.performanceId が NULL の行は「ライブ共通の披露曲」、あれば公演限定の追加曲 /
--     センター曲 (role)
--   - Song は曲名しか持たない非保護テーブル。曲は消さない (LiveSong から RESTRICT)
--   - Live は保護テーブル (classification の direct-classification RLS、MeetGreet と同形)。
--     LivePerformance / LiveSong は自前の classification を持たず、親 Live の可視性に従う
--     (RepoTweet → RepoCollection と同じ親参照パターン)
--   - Dossier が消えたら CASCADE で Live も消す。Entity / RepoCollection / Article は SET NULL
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "Live", "LivePerformance", "Song", "LiveSong" TO app_runtime;
--
-- 本番は SQL (+ GRANT) を先に当ててからデプロイする (新コードは /lives がテーブル無しで落ちる。
-- 旧コードは新テーブルを参照しないので先に当てても影響なし)。

-- CreateEnum
CREATE TYPE "LiveSongRole" AS ENUM ('performed', 'center');

-- CreateTable
CREATE TABLE "Live" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "entityId" TEXT,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "dossierId" TEXT NOT NULL,
    "repoCollectionId" TEXT,
    "articleId" TEXT,
    "reportTags" JSONB NOT NULL DEFAULT '[]',
    "sketchCandidates" JSONB NOT NULL DEFAULT '[]',
    "sketchKey" TEXT,
    "extraSketchPrompt" TEXT NOT NULL DEFAULT '',
    "articleExclusions" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Live_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LivePerformance" (
    "id" TEXT NOT NULL,
    "liveId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "venue" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LivePerformance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Song" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Song_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveSong" (
    "id" TEXT NOT NULL,
    "liveId" TEXT NOT NULL,
    "performanceId" TEXT,
    "songId" TEXT NOT NULL,
    "role" "LiveSongRole" NOT NULL DEFAULT 'performed',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LiveSong_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Live_dossierId_key" ON "Live"("dossierId");

-- CreateIndex
CREATE UNIQUE INDEX "Live_repoCollectionId_key" ON "Live"("repoCollectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Live_articleId_key" ON "Live"("articleId");

-- CreateIndex
CREATE INDEX "Live_classification_idx" ON "Live"("classification");

-- CreateIndex
CREATE INDEX "Live_entityId_idx" ON "Live"("entityId");

-- CreateIndex
CREATE INDEX "LivePerformance_liveId_idx" ON "LivePerformance"("liveId");

-- CreateIndex
CREATE INDEX "LivePerformance_date_idx" ON "LivePerformance"("date");

-- CreateIndex
CREATE UNIQUE INDEX "Song_title_key" ON "Song"("title");

-- CreateIndex
CREATE INDEX "LiveSong_liveId_idx" ON "LiveSong"("liveId");

-- CreateIndex
CREATE INDEX "LiveSong_performanceId_idx" ON "LiveSong"("performanceId");

-- CreateIndex
CREATE INDEX "LiveSong_songId_idx" ON "LiveSong"("songId");

-- AddForeignKey
ALTER TABLE "Live" ADD CONSTRAINT "Live_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Live" ADD CONSTRAINT "Live_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "Dossier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Live" ADD CONSTRAINT "Live_repoCollectionId_fkey" FOREIGN KEY ("repoCollectionId") REFERENCES "RepoCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Live" ADD CONSTRAINT "Live_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Live" ADD CONSTRAINT "Live_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LivePerformance" ADD CONSTRAINT "LivePerformance_liveId_fkey" FOREIGN KEY ("liveId") REFERENCES "Live"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveSong" ADD CONSTRAINT "LiveSong_liveId_fkey" FOREIGN KEY ("liveId") REFERENCES "Live"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveSong" ADD CONSTRAINT "LiveSong_performanceId_fkey" FOREIGN KEY ("performanceId") REFERENCES "LivePerformance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveSong" ADD CONSTRAINT "LiveSong_songId_fkey" FOREIGN KEY ("songId") REFERENCES "Song"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Song は非保護。Supabase の既定で付く anon / authenticated の DML を剥がす
-- (20260919020000_revoke_anon_on_unprotected と同じ理由。PostgREST から曲名を書き換えられないように)
REVOKE ALL ON TABLE "Song" FROM anon, authenticated;

-- RLS (clearance ベース、fail-closed)。clearance_rank() は 20260511000000_add_rls 定義。
ALTER TABLE "Live" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Live" FORCE  ROW LEVEL SECURITY;

CREATE POLICY live_select ON "Live" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY live_insert ON "Live" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY live_update ON "Live" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY live_delete ON "Live" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);

-- LivePerformance: 親 Live が可視なら可視 (RepoTweet → RepoCollection と同じ親参照パターン)
ALTER TABLE "LivePerformance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LivePerformance" FORCE  ROW LEVEL SECURITY;

CREATE POLICY liveperformance_select ON "LivePerformance" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LivePerformance"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY liveperformance_insert ON "LivePerformance" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LivePerformance"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY liveperformance_update ON "LivePerformance" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LivePerformance"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LivePerformance"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY liveperformance_delete ON "LivePerformance" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LivePerformance"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))));

-- LiveSong: 同じく親 Live 経由 (performanceId を辿らなくても liveId で判定できる)
ALTER TABLE "LiveSong" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LiveSong" FORCE  ROW LEVEL SECURITY;

CREATE POLICY livesong_select ON "LiveSong" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LiveSong"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY livesong_insert ON "LiveSong" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LiveSong"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY livesong_update ON "LiveSong" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LiveSong"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LiveSong"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY livesong_delete ON "LiveSong" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LiveSong"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
