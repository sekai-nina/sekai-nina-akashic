-- ============================================================
-- PGroonga が置き換えた pg_trgm インデックスを削除する (Issue #31)
--
-- 20260807000000_add_pgroonga_indexes で Asset / AssetText の検索は
-- PGroonga に移った。これらの trigram GIN インデックスは RLS 下で ILIKE が
-- leakproof でないために元々使われておらず、容量を食うだけになっている。
--
-- Entity の 2 本 (idx_entity_name_trgm / idx_entity_normalized_trgm) は残す。
-- Entity は RLS 対象外テーブルで、src/lib/actions.ts と
-- src/lib/domain/entities.ts のエンティティ検索が contains (ILIKE) で
-- これらを使えているため。
--
-- pg_trgm 拡張自体も残す (上記 2 本が依存している)。
-- ============================================================

DROP INDEX IF EXISTS idx_asset_title_trgm;
DROP INDEX IF EXISTS idx_asset_description_trgm;
DROP INDEX IF EXISTS idx_asset_message_preview_trgm;
DROP INDEX IF EXISTS idx_asset_text_content_trgm;
DROP INDEX IF EXISTS idx_asset_text_normalized_trgm;
