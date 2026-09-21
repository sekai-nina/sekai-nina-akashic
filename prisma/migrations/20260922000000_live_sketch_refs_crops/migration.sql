-- ライブの衣装スケッチに参考画像と切り抜き枠を持たせる (#150)
--
-- ミーグリのスケッチ生成 (#108) は、その後 #159 (回ごとの参考画像) と #136 (参照写真の
-- 切り抜き枠) で列が増えた。ライブも同じ生成の仕組みを共用するので、Live にも同じ 2 列を足す。
-- 形は MeetGreet.sketchRefs / sketchCrops と同じ。
--
-- 既存テーブルへの列追加のみ (既定値あり) なので手動 GRANT は不要。旧コードは列を参照しないので
-- 先に当ててよい。

ALTER TABLE "Live" ADD COLUMN "sketchRefs" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "sketchCrops" JSONB NOT NULL DEFAULT '{}';
