-- 出演ラベルで「出ていない」も記録する (#261)。
--
-- これまで坂井新奈の出演は AssetEntity (坂井新奈) があるかどうかだけで、Discord bot の ❌ は
-- 何も残さなかった。ラベルの無いアセットが「確認して出ていなかった」のか「未確認」なのか
-- 区別できないので、確認して出ていなかったことを Asset.ninaAbsent に持たせる。
--   出ている   = 坂井新奈の AssetEntity がある
--   出ていない = ninaAbsent
--   未確認     = どちらも無い
--
-- AssetEntity に「出ていない」を混ぜないのは、エンティティ検索・MCP の「坂井新奈」絞り込みが
-- 「紐づいている = 関係がある」前提で書かれているため。
--
-- Asset は既存の保護テーブルで、列の追加だけなので RLS・GRANT の追加は不要。
-- 適用直後は全件 false (= ラベルの無いものは未確認) で正しい。

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN "ninaAbsent" BOOLEAN NOT NULL DEFAULT false;

-- true は少数なので true の行だけの部分索引にする。Prisma の schema では書けないので
-- schema 管理外。`prisma migrate diff` がこの索引の DROP を出すので捨てること。
CREATE INDEX "Asset_ninaAbsent_idx" ON "Asset"(id) WHERE "ninaAbsent";
