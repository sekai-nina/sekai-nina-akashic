-- ============================================================
-- キーワード検索を pg_trgm (ILIKE) から PGroonga に置き換える (Issue #31)
--
-- ILIKE (texticlike) は PostgreSQL 17 でも leakproof ではない。RLS が
-- 有効なテーブルでは非 leakproof な条件を RLS ポリシーより先に評価できない
-- ため、trigram GIN インデックスが使えず Asset / AssetText が毎回 Seq Scan に
-- なっていた。結果、キーワード検索 1 件あたり 2 秒前後かかっていた。
--
-- PGroonga のマッチ演算子 (&@ = pgroonga_match_text) は leakproof なので、
-- RLS を保ったままインデックスが使える。実測 (app_runtime ロール /
-- clearance=restricted、Asset.title):
--   にぃたん            449.1ms -> 5.9ms   Seq Scan -> Index Scan
--   ただ隣で笑っていて   371.2ms -> 0.4ms   Seq Scan -> Index Scan
--   の (最悪ケース)      363.9ms -> 68.4ms  Seq Scan -> Index Scan
-- ヒット件数は 3 件とも ILIKE と完全一致する。
--
-- トークナイザは TokenNgram。unify_alphabet / unify_digit / unify_symbol を
-- すべて無効にして英数字・記号の途中でも一致させ、ILIKE の部分一致
-- セマンティクスを保つ。MeCab は Supabase にユーザー辞書を持ち込めず
-- 「にぃたん」等の固有名詞を取りこぼすため使わない。
--
-- unify_symbol は必ず無効にすること。有効 (既定) だと記号が独立トークンに
-- ならず、記号を含むクエリを取りこぼす。しかも PGroonga は自分のインデックスで
-- ILIKE も処理するため、取りこぼしは &@ だけでなく **既存の ILIKE クエリにも
-- 波及する** (実測: normalizedContent ILIKE '%!%' が索引ありで 22,916 件、
-- 索引を落とすと 31,573 件。unify_symbol 無効で 31,573 件に一致)。
--
-- 張る列は「正規化列があるものは正規化列だけ」。AssetText は
-- content と normalizedContent の両方を OR で見ていたのが最も重く
-- (9.6s)、normalizedContent 一本に絞るだけで 2.0s になる。
-- Entity は 441 行しかなく該当ブランチが 3.0ms なので索引を張らない
-- (pg_trgm の 2 本を残し、actions.ts のエンティティ検索がそれを使う)。
--
-- 置き換え済みの pg_trgm インデックス削除は次の migration
-- (20260807010000_drop_trgm_indexes) に分けてある。本番で問題が出た場合、
-- この migration だけ残してコードを revert すれば ILIKE + trgm に戻せる。
--
-- GRANT は不要 (既存テーブルへのインデックス追加のみで、新規テーブルは無い)。
-- CREATE INDEX CONCURRENTLY は使わない。Asset.title の構築が 1.75 秒で、
-- 書き込みが数秒ブロックされるだけのため。
-- ============================================================

-- Prisma は ?schema=public で接続するので、演算子が解決できるよう public に入れる
CREATE EXTENSION IF NOT EXISTS pgroonga WITH SCHEMA public;

-- Asset は正規化列を持たないので素の列に張る (大文字小文字・NFKC は
-- NormalizerNFKC130 が吸収する)
CREATE INDEX IF NOT EXISTS idx_asset_title_pgroonga
  ON "Asset" USING pgroonga ("title")
  WITH (tokenizer = 'TokenNgram("unify_alphabet", false, "unify_digit", false, "unify_symbol", false)',
        normalizers = 'NormalizerNFKC130');

CREATE INDEX IF NOT EXISTS idx_asset_description_pgroonga
  ON "Asset" USING pgroonga ("description")
  WITH (tokenizer = 'TokenNgram("unify_alphabet", false, "unify_digit", false, "unify_symbol", false)',
        normalizers = 'NormalizerNFKC130');

CREATE INDEX IF NOT EXISTS idx_asset_message_preview_pgroonga
  ON "Asset" USING pgroonga ("messageBodyPreview")
  WITH (tokenizer = 'TokenNgram("unify_alphabet", false, "unify_digit", false, "unify_symbol", false)',
        normalizers = 'NormalizerNFKC130');

-- AssetText は normalizedContent のみ。normalizeText() が {{IMG:xxx}} の除去と
-- 空白圧縮までしているので、素の content より取りこぼしが少ない
CREATE INDEX IF NOT EXISTS idx_asset_text_normalized_pgroonga
  ON "AssetText" USING pgroonga ("normalizedContent")
  WITH (tokenizer = 'TokenNgram("unify_alphabet", false, "unify_digit", false, "unify_symbol", false)',
        normalizers = 'NormalizerNFKC130');
