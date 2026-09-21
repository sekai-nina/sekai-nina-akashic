-- 器 (MeetGreet / Live) に使われている既存ドシエの記事テンプレートを埋める (#170 レビュー)
--
-- 20260922000000_dossier_article_template は「MeetGreet / Live のリレーションが真なので既存行は
-- 追随させない」としていたが、MeetGreet / Live は保護テーブルで、器が呼び出し側の機密より上だと
-- リレーションが見えない (RLS)。そのとき素のドシエに見えてしまい、器の素材ドシエに別のテンプレートを
-- 決めて記事を作れてしまう。アプリ層は `articleTemplate` が meetgreet / live なら器扱いにする
-- (`assertPlainDossier`) ので、既存行にも値を入れておく。
--
-- 既存テーブルの UPDATE のみ。RLS ポリシーの変更は無く、GRANT も不要。
-- 本番は SQL を先に当ててからデプロイする (旧コードはこの列を読まないので影響なし)。

UPDATE "Dossier" d SET "articleTemplate" = 'meetgreet'
FROM "MeetGreet" m
WHERE m."dossierId" = d."id" AND d."articleTemplate" IS NULL;

UPDATE "Dossier" d SET "articleTemplate" = 'live'
FROM "Live" l
WHERE l."dossierId" = d."id" AND d."articleTemplate" IS NULL;
