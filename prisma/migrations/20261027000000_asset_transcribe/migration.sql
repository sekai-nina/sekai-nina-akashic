-- 坂井新奈のトークの音声・動画を Groq で文字起こしする (#282)。
--
-- Asset.transcribedAt / transcribeError: 15 分ごとの cron が「まだのもの」を拾うための印。
-- 喋っていなくて本文が空だったものは AssetText が増えないので、AssetText の有無では
-- 「済み」を判定できない (毎回 Groq に送り直して課金される)。
--
-- LlmProvider.groq: 利用量を /costs に自己申告する。Groq は音声の秒数で課金するので、
-- inputTokens に課金秒数を入れる (src/lib/costs/pricing.ts)。
--
-- Asset は既存の保護テーブルで、列の追加だけなので RLS・GRANT の追加は不要。
-- enum の値は**コードより先に**当てる (足すときは DB が先、消すときはコードが先)。

-- AlterEnum
ALTER TYPE "LlmProvider" ADD VALUE 'groq';

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN "transcribeError" TEXT,
ADD COLUMN "transcribedAt" TIMESTAMP(3);
