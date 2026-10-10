-- 記事化の進捗 (#206 / #207)
--
-- 集めた素材 (本人ブログ・ひなあいの回など) を、どの反映先 (言葉記事・出演一覧の行など) まで
-- 記事にしたかを素材 × 反映先ごとに持つ。行に持つのは人が決めた状態 (対象外 / 手動の済) だけで、
-- 記事から導出できる「記事化済み」は保存しない。最初の利用者は /quotes (本人ブログ → 言葉記事)。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "ArticleProgress" TO app_runtime;

-- CreateEnum
CREATE TYPE "ProgressMaterialKind" AS ENUM ('blog');

-- CreateEnum
CREATE TYPE "ProgressTarget" AS ENUM ('quote_article');

-- CreateEnum
CREATE TYPE "ProgressStatus" AS ENUM ('excluded', 'done');

-- CreateTable
CREATE TABLE "ArticleProgress" (
    "id" TEXT NOT NULL,
    "materialKind" "ProgressMaterialKind" NOT NULL,
    "materialKey" TEXT NOT NULL,
    "target" "ProgressTarget" NOT NULL,
    "status" "ProgressStatus" NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArticleProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArticleProgress_materialKind_materialKey_target_key" ON "ArticleProgress"("materialKind", "materialKey", "target");

-- RLS (direct-classification)
ALTER TABLE "ArticleProgress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArticleProgress" FORCE ROW LEVEL SECURITY;

CREATE POLICY article_progress_select ON "ArticleProgress" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY article_progress_insert ON "ArticleProgress" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY article_progress_update ON "ArticleProgress" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY article_progress_delete ON "ArticleProgress" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
