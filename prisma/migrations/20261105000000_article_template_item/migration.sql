-- 記事テンプレートに「物」(item) を足す
--
-- 企画 (ドシエ) から `type: item` の記事を組めるようにする。組み立てと AI のルール文は
-- `src/lib/article-workflow/templates/item.ts` が持つ。
--
-- 値の追加なので、コードより先に本番へ当てる (画面で選んだ値を `Dossier.articleTemplate` に書くため)。
-- 適用してからマージまでは Preview で「物」を保存しない (古い Prisma Client が読めない値になる)。
-- 既存の行は変わらず、RLS ポリシーの変更も GRANT も要らない。

-- AlterEnum
ALTER TYPE "ArticleTemplate" ADD VALUE 'item';
