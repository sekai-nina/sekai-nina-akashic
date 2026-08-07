-- ============================================================
-- URL 貼り付け検索が使うインデックスを張る (#31 の積み残し)
--
-- 検索窓に URL を貼ると「その URL のアセットを引く」経路に入り、
-- SourceRecord.url / Asset.storageUrl / Asset.discordMessageUrl を
-- 完全一致 (= ANY) で引く。完全一致なので leakproof であり RLS 下でも
-- インデックスが使えるはずだったが、そもそもどの列にも btree が無く、
-- 3 本とも Seq Scan になっていた。
--
-- 実測 (app_runtime / clearance=restricted):
--   SourceRecord.url ブランチ        4,902ms (Asset を 122,043 行 Seq Scan して probe)
--   Asset.storageUrl ブランチ        3,059ms
--
-- 3 列とも NULL 可で、URL を持たないアセットのほうが多い。NULL は
-- 完全一致検索に絶対ヒットしないので部分インデックスにして小さく保つ。
--
-- GRANT は不要 (既存テーブルへのインデックス追加のみ)。
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_source_record_url
  ON "SourceRecord" ("url") WHERE "url" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_asset_storage_url
  ON "Asset" ("storageUrl") WHERE "storageUrl" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_asset_discord_message_url
  ON "Asset" ("discordMessageUrl") WHERE "discordMessageUrl" IS NOT NULL;
