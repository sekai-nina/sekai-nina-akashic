-- StatusCheckState に表示用の列 (group / name / description / notify) を足す (#100)
--
-- /status はチェックの名前とグループを出すが、その一部 (収集の鮮度) は DataSource の
-- 名前から来る。DataSource は保護テーブルなので、ページが定義を組み立て直すと
-- prismaInternal で読むことになる。評価時に名前とグループを状態の行に写しておけば、
-- ページは非保護の StatusCheckState と Job だけで描ける。
--
-- 20260917100000_pipeline_status の直後に足す追加列。まだ行が無いので group / name は
-- 既定値なしの NOT NULL でよい (schema と揃えて migrate diff に差分を残さない)。
-- 手動 GRANT は不要 (列の権限はテーブル単位)。

-- AlterTable
ALTER TABLE "StatusCheckState" ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "group" TEXT NOT NULL,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "notify" BOOLEAN NOT NULL DEFAULT true;
