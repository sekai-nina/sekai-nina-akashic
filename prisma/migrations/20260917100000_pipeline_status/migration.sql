-- パイプライン監視 (/status) のテーブルを足す (#100)
--
-- discord-bot の今日の発見抽出が 2 ヶ月止まっていたことに誰も気づけなかったので、
-- 収集・加工の結果が集まる akashic に「今どこまで最新か / 何が失敗しているか」を
-- 俯瞰する仕組みを置く。
--
--   - Job / JobRun: bot や外部ワーカーの各ジョブが実行ごとに結果を報告する受け口
--     (POST /api/v1/jobs/{key}/runs)。Job は初回の報告で自動作成される。
--     ok で count=0 の報告が続くときは JobRun を増やさず Job.lastOkAt だけ更新する
--   - StatusCheckState: Cron (GET /api/cron/status) が評価した各チェックの現在状態。
--     Discord 通知の遷移判定と /status の表示はこれを読む
--
-- いずれも件数・時刻・メッセージしか持たない運用情報なので非保護 (RLS 対象外)。
-- アプリからは素の prisma で触る。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "Job", "JobRun", "StatusCheckState" TO app_runtime;
--
-- 本番は SQL (+ GRANT) を先に当ててからデプロイする (新コードはテーブルが無いと
-- /status と cron が落ちる。旧コードは新テーブルを参照しないので先に当てても影響なし)。

-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('ok', 'error');

-- CreateEnum
CREATE TYPE "StatusLevel" AS ENUM ('ok', 'warn', 'error', 'unknown');

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "intervalSec" INTEGER,
    "lastRunAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastStatus" "JobRunStatus",
    "lastMessage" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" "JobRunStatus" NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "count" INTEGER,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusCheckState" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" "StatusLevel" NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "detail" JSONB NOT NULL DEFAULT '{}',
    "since" TIMESTAMP(3) NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "lastNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatusCheckState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Job_key_key" ON "Job"("key");

-- CreateIndex
CREATE INDEX "JobRun_jobId_createdAt_idx" ON "JobRun"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "JobRun_createdAt_idx" ON "JobRun"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StatusCheckState_key_key" ON "StatusCheckState"("key");

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
