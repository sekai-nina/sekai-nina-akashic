-- 記事テンプレートの AI プロンプトを画面 (/admin/article-prompts) から確認・修正できるようにする
--
-- ArticlePromptSetting
--   おでかけ・スナップ・言葉 (場面) の AI に渡すルール文 (役割・本文の形・鉄則・出力・見本) が
--   コードに埋め込みで、いまどう書いてあるかを画面から見られず、直すのにデプロイが要った。
--   テンプレートごとに 1 行持ち、空なら組み込みの既定を使う (入れ忘れで生成が止まらないように。
--   SketchSetting と同じ考え方)。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "ArticlePromptSetting" TO app_runtime;

CREATE TABLE "ArticlePromptSetting" (
    "template" "ArticleTemplate" NOT NULL,
    "rules" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',

    CONSTRAINT "ArticlePromptSetting_pkey" PRIMARY KEY ("template")
);

CREATE INDEX "ArticlePromptSetting_classification_idx" ON "ArticlePromptSetting"("classification");

ALTER TABLE "ArticlePromptSetting" ADD CONSTRAINT "ArticlePromptSetting_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS (direct-classification パターン。SketchSetting と同じ)
ALTER TABLE "ArticlePromptSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArticlePromptSetting" FORCE ROW LEVEL SECURITY;

CREATE POLICY articlepromptsetting_select ON "ArticlePromptSetting" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY articlepromptsetting_insert ON "ArticlePromptSetting" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY articlepromptsetting_update ON "ArticlePromptSetting" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY articlepromptsetting_delete ON "ArticlePromptSetting" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
