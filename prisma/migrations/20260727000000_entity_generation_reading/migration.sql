-- 期別 (person のみ) と五十音順の並び替え用の読み仮名
ALTER TABLE "Entity" ADD COLUMN "generation" INTEGER;
ALTER TABLE "Entity" ADD COLUMN "reading" TEXT;
