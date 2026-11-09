-- エンティティ詳細 (/entities/[id]) の「最新の紐づき 20 件」用の索引。
--
-- `AssetEntity WHERE entityId = ? ORDER BY createdAt DESC LIMIT 20` は entityId だけの索引だと
-- そのエンティティの紐づきを全部読んで並べ替える。坂井新奈 (約 5,000 件) や上村ひなの (約 6,400 件) では、
-- DB のメモリに載っていないとき 2〜4.5 秒かかっていた。(entityId, createdAt) なら先頭 20 件で止まる。
--
-- 新しいテーブルではないので GRANT は要らない。AssetEntity (約 39 万行) に普通の CREATE INDEX を張るので、
-- 数秒だけ書き込みが待たされる。
CREATE INDEX "AssetEntity_entityId_createdAt_idx" ON "AssetEntity"("entityId", "createdAt");
