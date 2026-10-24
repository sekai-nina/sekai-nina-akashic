-- 「本文が坂井新奈に言及しているか」をアセットに溜める (/progress の高速化)。
--
-- これまで /progress と /coverage の関連判定は、開くたびに AssetText 全体を PGroonga で
-- 名前・別名 (17 語) 検索していた。冷えた DB で約 3.6 秒かかり、久しぶりに開くと待たされる。
-- 判定結果を Asset.mentionsNina に持たせ、15 分ごとの cron (/api/cron/nina-mentions) と
-- `pnpm cli:refresh-nina-mentions --apply` が付け外しする。
--
-- AssetEntity に付けないのは、検索・エンティティページ・MCP の「坂井新奈」絞り込みに
-- 機械判定 (別名「坂井」「🩰」などの誤一致を含む) を混ぜないため。
--
-- Asset は既存の保護テーブルで、列の追加だけなので RLS・GRANT の追加は不要。
-- 適用直後は全件 false。コードを出す前に `pnpm cli:refresh-nina-mentions --apply` で埋める
-- (埋めないと最初の cron まで言及だけのアセットが関連判定から落ちる)。

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN "mentionsNina" BOOLEAN NOT NULL DEFAULT false;

-- true は千数百件 (Asset の約 1.5%) なので、true の行だけの部分索引にする。
-- Prisma の schema では書けないので schema 管理外。`prisma migrate diff` がこの索引の
-- DROP を出すので、PGroonga の索引と同じく捨てること。
CREATE INDEX "Asset_mentionsNina_idx" ON "Asset"(id) WHERE "mentionsNina";
