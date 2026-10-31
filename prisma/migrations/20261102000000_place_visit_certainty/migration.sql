-- 聖地の訪問に確度 (確定 / ほぼ確定) を持たせる (#333)。
--
-- ArticlePlace (記事×聖地 = 訪問) に certainty / certaintyNote を足す。likely (ほぼ確定) は
-- 「証言から十中八九ここだが、確定できるほど検証できる材料が無い」訪問で、push で frontmatter の
-- locations に書かれ、公開サイトで印と理由が出る。既存の行は confirmed (今の見た目のまま)。
--
-- 企画の聖地候補 (DossierPlaceCandidate) にも同じ 2 列を足し、記事の生成で訪問に引き継ぐ。
-- 候補の数値 confidence (0-100) はどこにも使われていなかったので入力をやめるが、列は残す。
--
-- 既存テーブルへの列追加だけなので、新しい GRANT は要らない (RLS ポリシーも列に依存しない)。

-- CreateEnum
CREATE TYPE "PlaceCertainty" AS ENUM ('confirmed', 'likely');

-- AlterTable
ALTER TABLE "DossierPlaceCandidate" ADD COLUMN     "certainty" "PlaceCertainty" NOT NULL DEFAULT 'confirmed',
ADD COLUMN     "certaintyNote" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "ArticlePlace" ADD COLUMN     "certainty" "PlaceCertainty" NOT NULL DEFAULT 'confirmed',
ADD COLUMN     "certaintyNote" TEXT NOT NULL DEFAULT '';
