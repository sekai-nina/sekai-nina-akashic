-- 顔認識 (#403): トークの動画も何コマか切り出して判定する。
-- FaceDetection に「動画の何秒目の顔か」を足す。画像は null。
-- 列の追加だけなので GRANT は要らない (テーブルの権限がそのまま効く)。RLS も既存のポリシーのまま

-- AlterTable
ALTER TABLE "FaceDetection" ADD COLUMN "frameSec" DOUBLE PRECISION;
