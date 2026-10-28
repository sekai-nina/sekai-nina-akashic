-- 公演のセトリ (LiveSetlistItem) の出典を LivePerformance に持つ
--
-- セトリはファンサイト・公式の投稿などから写すので、どこから写したかを残して公開サイトに出す
-- (出どころを隠さない)。セトリを保存するときはラベル必須、URL は任意 (アプリで検証)。
-- 既存の表への列追加なので GRANT は不要。旧コードはこの列を読まないので先に当てても影響なし。

-- AlterTable
ALTER TABLE "LivePerformance" ADD COLUMN "setlistSourceLabel" TEXT NOT NULL DEFAULT '',
ADD COLUMN "setlistSourceUrl" TEXT NOT NULL DEFAULT '';
