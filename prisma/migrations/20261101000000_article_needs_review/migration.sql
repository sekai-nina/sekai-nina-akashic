-- 記事に「AI 書きたて（未確認）」の印を足す (#327)。
--
-- 企画・REST / MCP から作った記事で true になり、編集画面の「確認済みにする」で外す。
-- push 画面では印の付いた記事を選べない。frontmatter には出ない。
-- 既存の記事はすべて false (確認済み扱い)。
--
-- 既存テーブル (Article は非保護) への列追加なので、app_runtime の GRANT は不要。

-- AlterTable
ALTER TABLE "Article" ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false;
