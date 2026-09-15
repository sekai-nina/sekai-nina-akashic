-- ArticleType から quiz を外し、sekai-nina-site の enum と揃える (#74)
--
-- Astro 側 (src/content/config.ts) の type は attribute / fact / state / event /
-- quote / column / item で、quiz は無い。akashic 側から type: quiz を push すると
-- Astro のビルドが落ちる。quiz/ 配下の 3 記事は type: attribute で、DB にも
-- quiz の行は 0 件なので、値を消しても影響は無い。
--
-- Postgres は enum の値を直接削除できないので、型を作り直して列を付け替える
-- (prisma migrate diff の生成そのまま)。Article_type_idx は ALTER COLUMN TYPE が
-- 自動で張り直す。
--
-- 手動 GRANT は不要 (新しいテーブルは無く、型の USAGE は既定で PUBLIC に付く)。

-- AlterEnum
BEGIN;
CREATE TYPE "ArticleType_new" AS ENUM ('attribute', 'event', 'quote', 'column', 'item');
ALTER TABLE "Article" ALTER COLUMN "type" TYPE "ArticleType_new" USING ("type"::text::"ArticleType_new");
ALTER TYPE "ArticleType" RENAME TO "ArticleType_old";
ALTER TYPE "ArticleType_new" RENAME TO "ArticleType";
DROP TYPE "ArticleType_old";
COMMIT;
