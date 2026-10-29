-- 企画の素材をどこまで記事に取り込んだかを記事に持たせる
--
-- Article.materialsSyncedAt
--   本文を AI / 人が書くテンプレート (おでかけ・スナップ・言葉 (場面)) の追記は「新しい出典」が
--   あるかでしか見ていなかった。記事にもう出典として載っているブログ・トークへのクリップに
--   メモ (「バタービールを飲んだ」等) を付けて足しても、出典は増えないので「差分なし」になり、
--   メモの中身を本文に組み込む口が無かった。
--   新規作成と組み込みの保存がこの時刻を書き、これより後に入ったメモ・抜粋つきのクリップを
--   新しい素材として扱う。
--
-- 既存の記事は、作成日時と最後の組み込みの保存 (監査ログ dossier.article.ai_merge_save) の
-- 遅いほうで埋める。2026-10-30 に本番で数え、これで新しい素材に上がるのは
-- 「下田衣珠季とハリー・ポッタースタジオツアー」の 5 件だけ (意図どおり)。
-- 既存のテーブルへの列追加なので GRANT は要らない。

ALTER TABLE "Article" ADD COLUMN "materialsSyncedAt" TIMESTAMP(3);

UPDATE "Article" a
SET "materialsSyncedAt" = GREATEST(
  a."createdAt",
  COALESCE(
    (
      SELECT max(l."createdAt")
      FROM "AuditLog" l
      WHERE l."action" = 'dossier.article.ai_merge_save'
        AND l."metadata"->>'shortId' = a."shortId"
    ),
    a."createdAt"
  )
)
WHERE a."dossierId" IS NOT NULL;
