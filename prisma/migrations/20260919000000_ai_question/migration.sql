-- 案内AI「ふぃたん」に来た質問と回答を溜める AiQuestion を足す
--
-- これまでは Worker の KV に置くだけで、中身を見るには wrangler でキーを列挙するしかなく、
-- 「どんな質問が来ているか」を人が眺められなかった。アーカイブの穴を探す作業は、
-- まず人が直感的に質問を眺められることが出発点なので、Akashic に入れて一覧にする。
--
--   - 1問1答で 1 行。個人を特定できる情報は受け取らない（IP・UA・リファラ・セッションIDは
--     Worker 側でも保存していない）ので、同じ人の連続した質問を結び付ける手段は無い
--   - citationCount = 0 は「答えられなかった質問」。穴の第一候補
--   - 公開している方針文(/ai)の「最大180日間保存」に合わせ、expiresAt を過ぎた行は消す
--     (scripts/purge-ai-questions.ts を日次で回す)
--   - KV 側の log: も残す（Akashic が落ちていても質問を失わないため）
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "AiQuestion" TO app_runtime;

-- CreateTable
CREATE TABLE "AiQuestion" (
    "id" TEXT NOT NULL,
    "askedAt" TIMESTAMP(3) NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "citationCount" INTEGER NOT NULL DEFAULT 0,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "origin" TEXT NOT NULL DEFAULT '',
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiQuestion_askedAt_idx" ON "AiQuestion"("askedAt");
CREATE INDEX "AiQuestion_citationCount_askedAt_idx" ON "AiQuestion"("citationCount", "askedAt");
CREATE INDEX "AiQuestion_expiresAt_idx" ON "AiQuestion"("expiresAt");
CREATE INDEX "AiQuestion_classification_idx" ON "AiQuestion"("classification");

-- RLS (clearance ベース、fail-closed)。clearance_rank() は 20260511000000_add_rls 定義。
ALTER TABLE "AiQuestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiQuestion" FORCE  ROW LEVEL SECURITY;

CREATE POLICY aiquestion_select ON "AiQuestion" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY aiquestion_insert ON "AiQuestion" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY aiquestion_update ON "AiQuestion" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY aiquestion_delete ON "AiQuestion" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
