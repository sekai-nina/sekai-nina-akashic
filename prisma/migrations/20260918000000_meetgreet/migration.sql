-- ミーグリ記事の作成ワークフローの器 MeetGreet を足す (#106 / #107)
--
-- ミーグリ 1 回分の記事を作るのに、ドシエ組み立て → /repo で X レポ収集 → ChatGPT で
-- スケッチ → ローカル Claude Code で記事化、と手作業が 4 段あった。処理本体を akashic に
-- 持たせるため、1 回のミーグリにつき 1 行で「日付・形式・シングル」と、素材置き場の
-- Dossier (1:1、作成時に自動生成)・X レポの RepoCollection・生成した Article の紐づけ、
-- スケッチ候補 / 確定 (PR2) を持つ。ドシエ / /repo / 記事の各画面はそのまま使う。
--
--   - date は JST の "YYYY-MM-DD" 文字列 (RepoCollection.startDate と同じ TZ 事故回避)
--   - Dossier が消えたら CASCADE でこの行も消す。RepoCollection / Article は SET NULL
--   - 保護テーブル。classification の direct-classification RLS (Place / RepoCollection と同形)
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "MeetGreet" TO app_runtime;
--
-- 本番は SQL (+ GRANT) を先に当ててからデプロイする (新コードは /meetgreets がテーブル無しで
-- 落ちる。旧コードは新テーブルを参照しないので先に当てても影響なし)。

-- CreateEnum
CREATE TYPE "MeetGreetFormat" AS ENUM ('online', 'real');

-- CreateTable
CREATE TABLE "MeetGreet" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "format" "MeetGreetFormat" NOT NULL,
    "single" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL DEFAULT '',
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "dossierId" TEXT NOT NULL,
    "repoCollectionId" TEXT,
    "articleId" TEXT,
    "sketchCandidates" JSONB NOT NULL DEFAULT '[]',
    "sketchKey" TEXT,
    "extraSketchPrompt" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetGreet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MeetGreet_dossierId_key" ON "MeetGreet"("dossierId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetGreet_repoCollectionId_key" ON "MeetGreet"("repoCollectionId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetGreet_articleId_key" ON "MeetGreet"("articleId");

-- CreateIndex
CREATE INDEX "MeetGreet_date_idx" ON "MeetGreet"("date");

-- CreateIndex
CREATE INDEX "MeetGreet_classification_idx" ON "MeetGreet"("classification");

-- AddForeignKey
ALTER TABLE "MeetGreet" ADD CONSTRAINT "MeetGreet_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "Dossier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetGreet" ADD CONSTRAINT "MeetGreet_repoCollectionId_fkey" FOREIGN KEY ("repoCollectionId") REFERENCES "RepoCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetGreet" ADD CONSTRAINT "MeetGreet_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetGreet" ADD CONSTRAINT "MeetGreet_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS (clearance ベース、fail-closed)。clearance_rank() は 20260511000000_add_rls 定義。
ALTER TABLE "MeetGreet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MeetGreet" FORCE  ROW LEVEL SECURITY;

CREATE POLICY meetgreet_select ON "MeetGreet" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY meetgreet_insert ON "MeetGreet" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY meetgreet_update ON "MeetGreet" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY meetgreet_delete ON "MeetGreet" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
