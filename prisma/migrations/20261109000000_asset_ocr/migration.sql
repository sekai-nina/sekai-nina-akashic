-- 画像アセットに Claude で OCR をかける (#379)。
--
-- Asset.ocrAt / ocrError: 15 分ごとの cron が「まだのもの」を拾うための印。
-- 文字が無くて本文が空だったものは AssetText が増えないので、AssetText の有無では
-- 「済み」を判定できない (毎回 Claude に送り直して課金される)。
-- Asset.ocrRequestedAt: 子アセット一覧の「まとめて OCR」で立て、cron の対象に入れる。
--
-- Asset は既存の保護テーブルで、列の追加だけなので RLS・GRANT の追加は不要。

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN "ocrAt" TIMESTAMP(3),
ADD COLUMN "ocrError" TEXT,
ADD COLUMN "ocrRequestedAt" TIMESTAMP(3);
