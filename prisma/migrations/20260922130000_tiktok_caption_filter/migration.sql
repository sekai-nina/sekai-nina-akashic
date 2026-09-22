-- TikTok 監視対象にキャプションの絞り込みを持たせる (#179 追補)
--
-- Lemino の坂道チャンネル (@lemino_sakamichi) のように、複数グループを 1 つの垢で流す対象から
-- 日向坂の動画だけ取り込みたい。空なら全部、`|` 区切りでいずれかを含むものだけ取り込み、
-- 合わないものは既知 (skipped_initial) として台帳に載せる。
--
-- 既存テーブルへの列追加のみ (既定値あり) なので手動 GRANT は不要。

ALTER TABLE "TiktokWatchTarget" ADD COLUMN "captionFilter" TEXT NOT NULL DEFAULT '';
