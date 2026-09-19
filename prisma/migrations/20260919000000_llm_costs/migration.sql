-- LLM の利用コストと残クレジットのテーブルを足す (#117)
--
-- LLM を呼ぶ場所が 6 つ (akashic の口コミ抽出 / bot の今日の発見・OCR・github_sync /
-- サイトのふぃたん (Gemini) / Discord のふぃたん (Anthropic)) に分かれていて、
-- どこにいくらかかっているか・クレジットがどれだけ残っているかが分からない。
--
--   - LlmCostDaily: プロバイダの Admin API から引いた**権威ある日次金額**。
--     コードを通らない利用 (手元の Claude Code 等) も含む
--   - LlmUsageDaily: 各呼び出し側が報告したトークン数 (日次 × モデル × 機能)。
--     価格表 (src/lib/costs/pricing.ts) で USD に換算する。**価格表に無いモデルは
--     costUsd を null にしてトークンだけ残す** (黙って 0 円にしない)
--   - CreditSnapshot: 観測した残高。残高を返す API は 3 社とも無いので、
--     「いつ時点で残り $X」を人が 1 行入れ、以降の支出を引いて推定する
--
-- いずれも金額・トークン数しか持たない運用情報なので非保護 (RLS 対象外)。
-- アプリからは素の prisma で触る。画面 (/costs) は admin のみ。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "LlmUsageDaily", "LlmCostDaily", "CreditSnapshot" TO app_runtime;
--
-- 本番は SQL (+ GRANT) を先に当ててからデプロイする (新コードはテーブルが無いと
-- /costs と cron が落ちる。旧コードは新テーブルを参照しないので先に当てても影響なし)。

-- CreateEnum
CREATE TYPE "LlmProvider" AS ENUM ('openai', 'anthropic', 'google');

-- CreateEnum
CREATE TYPE "LlmUsageSource" AS ENUM ('reported', 'provider');

-- CreateTable
CREATE TABLE "LlmUsageDaily" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "provider" "LlmProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6),
    "source" "LlmUsageSource" NOT NULL DEFAULT 'reported',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmUsageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCostDaily" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "provider" "LlmProvider" NOT NULL,
    "amountUsd" DECIMAL(12,6) NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmCostDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditSnapshot" (
    "id" TEXT NOT NULL,
    "provider" "LlmProvider" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "balanceUsd" DECIMAL(12,2) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LlmUsageDaily_date_idx" ON "LlmUsageDaily"("date");

-- CreateIndex
CREATE INDEX "LlmUsageDaily_provider_date_idx" ON "LlmUsageDaily"("provider", "date");

-- CreateIndex
CREATE UNIQUE INDEX "LlmUsageDaily_date_provider_model_feature_source_key" ON "LlmUsageDaily"("date", "provider", "model", "feature", "source");

-- CreateIndex
CREATE INDEX "LlmCostDaily_provider_date_idx" ON "LlmCostDaily"("provider", "date");

-- CreateIndex
CREATE UNIQUE INDEX "LlmCostDaily_date_provider_key" ON "LlmCostDaily"("date", "provider");

-- CreateIndex
CREATE INDEX "CreditSnapshot_provider_observedAt_idx" ON "CreditSnapshot"("provider", "observedAt");

-- AddForeignKey
ALTER TABLE "CreditSnapshot" ADD CONSTRAINT "CreditSnapshot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
