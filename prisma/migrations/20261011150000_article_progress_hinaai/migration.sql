-- 記事化の進捗にひなあいを足す (#208)
--
-- ひなあいの回ごとに「出演一覧の行」と「記事化」の 2 つの反映先を持つ。
-- enum に値を足すだけ。テーブルは 20261011120000_article_progress のまま (GRANT 不要)。
ALTER TYPE "ProgressMaterialKind" ADD VALUE 'hinaai';
ALTER TYPE "ProgressTarget" ADD VALUE 'list_row';
ALTER TYPE "ProgressTarget" ADD VALUE 'articles';
