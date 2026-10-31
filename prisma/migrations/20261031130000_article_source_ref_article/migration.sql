-- 記事の出典に別の記事を指せるようにする (#320)。
--
-- ArticleSource.refArticleId → Article.id。削除時は SetNull (url 列に `/articles/<shortId>` を
-- 同じく持つので、参照先が消えても出典の行は残る)。frontmatter に書くのは url だけで、
-- 公開サイトがその時の記事タイトルを出す。
--
-- 既存テーブルへの列追加なので、app_runtime の GRANT は不要 (テーブル単位の権限がそのまま効く)。
-- ArticleSource の RLS は classification で判定しており、この列は関係しない。

-- AlterTable
ALTER TABLE "ArticleSource" ADD COLUMN "refArticleId" TEXT;

-- CreateIndex
CREATE INDEX "ArticleSource_refArticleId_idx" ON "ArticleSource"("refArticleId");

-- AddForeignKey
ALTER TABLE "ArticleSource" ADD CONSTRAINT "ArticleSource_refArticleId_fkey" FOREIGN KEY ("refArticleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;
