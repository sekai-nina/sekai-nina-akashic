-- 動画の長さ (#動画の場面の長さ絞り込み)
-- 動画の場面の一覧を「〜1分 / 1〜10分 / 10分以上」で絞り、長い順に並べるため、Asset に長さを持たせる。
-- 長さは 15 分ごとの cron が Google Drive の videoMediaMetadata.durationMillis から埋める (ダウンロードしない)。
-- Drive が長さを持っていないものは 1 日おきに 3 回まで問い合わせ直し、それでも無ければ null (長さ不明) のまま。
--
-- 既存テーブルへの列追加なので、app_runtime への GRANT は不要 (テーブル単位の権限が効く)。
-- 定数の DEFAULT 付き ADD COLUMN は表を書き直さない (PostgreSQL 11+)。

ALTER TABLE "Asset" ADD COLUMN "durationProbeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "durationProbedAt" TIMESTAMP(3),
ADD COLUMN "durationSec" DOUBLE PRECISION;
