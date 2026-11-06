-- 複数のメッセージを 1 つのクリップに束ねる
--
-- クリップの行は 1 アセットしか持てず、記事の出典もアセットごとに付く。行は分けたまま
-- 同じ clipGroupId を持たせ、/clips では 1 枚のカードとして見せる。
-- 列を足すだけで既存の行は null のまま。Prisma が列を読むので、コードより先に本番へ当てる。
-- 既存テーブルなので GRANT と RLS の追加は要らない。

-- AlterTable
ALTER TABLE "DossierItem" ADD COLUMN "clipGroupId" TEXT;

-- CreateIndex
CREATE INDEX "DossierItem_clipGroupId_idx" ON "DossierItem"("clipGroupId");
