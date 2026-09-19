-- クリップ (記事未定の抜粋) のプールと、記事 ↔ 素材ドシエのリンク (#41)
--
-- 変更内容:
--   1. DossierKind enum (general / clips) と Dossier.kind
--      クリップは「kind = clips の共有ドシエ 1 本」の DossierItem として持つ。
--      新テーブルにしないので RLS / GRANT / バックアップは既存の Dossier 系のまま。
--      1 本だけであることは部分ユニーク索引 Dossier_clips_singleton で担保する
--      (Prisma は部分索引を表現できないので schema.prisma には無い。migrate diff が
--      DROP を提案しても捨てること。trgm / pgroonga 索引と同じ扱い)
--   2. DossierItem.createdById — 入れた人。クリップ一覧の「自分のだけ」に使う。既存行は null
--   3. Article.dossierId — 素材ドシエ。クリップを「この記事に足す」ときの移動先。
--      akashic 内部のリンクで frontmatter には出さない。既存記事は
--      `pnpm cli:backfill-article-dossiers` で埋める (frontmatterExtra.dossier.id からのリンクと、
--      出典アセットを DossierItem に写した新規ドシエの作成)
--
-- RLS の変更は無い (列追加のみ)。DossierItem の移動 (dossierId の付け替え) は既存の
-- dossieritem_update ポリシーで USING = 移動元 / WITH CHECK = 移動先のドシエが評価される。
--
-- 既存テーブルへの列追加だけなので本番の手動 GRANT は不要 (GRANT はテーブル単位)。
-- enum の追加なので **DB → コードの順** でデプロイする。

-- CreateEnum
CREATE TYPE "DossierKind" AS ENUM ('general', 'clips');

-- AlterTable
ALTER TABLE "Dossier" ADD COLUMN "kind" "DossierKind" NOT NULL DEFAULT 'general';

-- AlterTable
ALTER TABLE "DossierItem" ADD COLUMN "createdById" TEXT;

-- AlterTable
ALTER TABLE "Article" ADD COLUMN "dossierId" TEXT;

-- CreateIndex
CREATE INDEX "Dossier_kind_idx" ON "Dossier"("kind");

-- クリップのプールは全体で 1 本だけ
CREATE UNIQUE INDEX "Dossier_clips_singleton" ON "Dossier"("kind") WHERE "kind" = 'clips';

-- CreateIndex
CREATE INDEX "DossierItem_createdById_idx" ON "DossierItem"("createdById");

-- CreateIndex
CREATE INDEX "Article_dossierId_idx" ON "Article"("dossierId");

-- AddForeignKey
ALTER TABLE "DossierItem" ADD CONSTRAINT "DossierItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "Dossier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
