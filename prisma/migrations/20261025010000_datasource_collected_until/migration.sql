-- /coverage を「どこまで集めたか」の管理に作り直す (#253)。
-- ハートビートで出せないソース（雑誌・ラジオなど）の「いつまでの分を取り込んだか」を手で入れるため、
-- DataSource に収集済みの日付（JST の暦日）と、最後に設定した日時・設定者を持たせる。
-- null 可の列追加だけなので既存コードと互換。既存テーブルの RLS / GRANT を引き継ぐため追加 GRANT は不要。
-- 本番はこの SQL を先に当ててから新コードをデプロイする（逆だと DataSource を読む画面・API が列不在で落ちる）。

-- AlterTable
ALTER TABLE "DataSource" ADD COLUMN     "collectedUntil" DATE,
ADD COLUMN     "collectedUntilUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "collectedUntilUpdatedById" TEXT;
