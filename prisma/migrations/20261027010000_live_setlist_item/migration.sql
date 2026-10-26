-- 公演のセットリスト (全曲・順番・坂井新奈の参加・センター) を持つ LiveSetlistItem を足す
--
-- これまで公演の曲は LiveSong に「坂井新奈が出た曲」だけを、共通披露曲 / 追加曲 / センター曲に
-- 分けて持っていた。セトリそのもの (出ていない曲も含めた全曲と順番、アンコールの区切り) は
-- 残せなかったので、公演ごとの全曲をこの表に持つ。
--
--   - 入力の正はこの表。公演にセトリがあれば、保存のたびにアプリ (deriveSongsFromSetlists) が
--     ライブの LiveSong を参加した曲だけで組み直す。LiveSong を読む記事・/songs・公開サイトは変えない
--   - セトリの無い公演は従来どおり LiveSong の手入力が正 (過去のライブを入れ直さなくてよい)
--   - 同じ曲を 2 回披露したら 2 行 (position で区別)。unique は張らない
--   - 自前の classification は持たず、親 Live の可視性に従う (LiveSong と同じ親参照パターン)
--   - Song は RESTRICT (曲の統合は mergeSongs がこの表も付け替える)
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "LiveSetlistItem" TO app_runtime;
--
-- 本番は SQL (+ GRANT) を先に当ててからデプロイする (新コードは /lives でこの表を読む。
-- 旧コードは参照しないので先に当てても影響なし)。

-- CreateTable
CREATE TABLE "LiveSetlistItem" (
    "id" TEXT NOT NULL,
    "liveId" TEXT NOT NULL,
    "performanceId" TEXT NOT NULL,
    "songId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "section" TEXT NOT NULL DEFAULT '',
    "participated" BOOLEAN NOT NULL DEFAULT true,
    "center" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LiveSetlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveSetlistItem_liveId_idx" ON "LiveSetlistItem"("liveId");

-- CreateIndex
CREATE INDEX "LiveSetlistItem_performanceId_idx" ON "LiveSetlistItem"("performanceId");

-- CreateIndex
CREATE INDEX "LiveSetlistItem_songId_idx" ON "LiveSetlistItem"("songId");

-- AddForeignKey
ALTER TABLE "LiveSetlistItem" ADD CONSTRAINT "LiveSetlistItem_liveId_fkey" FOREIGN KEY ("liveId") REFERENCES "Live"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveSetlistItem" ADD CONSTRAINT "LiveSetlistItem_performanceId_fkey" FOREIGN KEY ("performanceId") REFERENCES "LivePerformance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveSetlistItem" ADD CONSTRAINT "LiveSetlistItem_songId_fkey" FOREIGN KEY ("songId") REFERENCES "Song"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: 親 Live 経由 (LiveSong と同じ。performanceId を辿らなくても liveId で判定できる)
ALTER TABLE "LiveSetlistItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LiveSetlistItem" FORCE  ROW LEVEL SECURITY;

CREATE POLICY livesetlistitem_select ON "LiveSetlistItem" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LiveSetlistItem"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY livesetlistitem_insert ON "LiveSetlistItem" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LiveSetlistItem"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY livesetlistitem_update ON "LiveSetlistItem" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LiveSetlistItem"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LiveSetlistItem"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY livesetlistitem_delete ON "LiveSetlistItem" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Live" l WHERE l.id = "LiveSetlistItem"."liveId"
    AND clearance_rank(l.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
