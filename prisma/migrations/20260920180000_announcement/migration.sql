-- お知らせの器 Announcement を足す
--
-- 公開サイト (sekai-nina-site) のトップと /news に出す、運営からのお知らせ (機能を足した・
-- 記事を更新した・停止する 等)。X に投稿しなくても伝わる経路にするのが目的で、正はここ。
-- サイトはビルド時に読むほか、閲覧時にも stats Worker 経由で GET /api/v1/announcements を
-- 取りに行くので、保存すれば再ビルド無しで数分で出る。
--
--   - publishedAt が null の行は下書き。API の既定 (status=published) には出ない
--   - 本文は Markdown。描画は記事と同じ renderArticleBody (= [[記事名]] も効く)
--   - 全部が公開前提で機密を持たないので **非保護テーブル** (Article と同じ)。RLS は張らず、
--     代わりに anon / authenticated の権限を剥がして PostgREST から閉じる (docs/security-dev.md)
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "Announcement" TO app_runtime;
--
-- 本番は SQL (+ GRANT) を先に当ててからデプロイする (新コードは /announcements がテーブル無しで
-- 落ちる。旧コードは新テーブルを参照しないので先に当てても影響なし)。

-- CreateEnum
CREATE TYPE "AnnouncementKind" AS ENUM ('feature', 'article', 'info');

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "kind" "AnnouncementKind" NOT NULL DEFAULT 'info',
    "url" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Announcement_publishedAt_idx" ON "Announcement"("publishedAt");

-- 非保護テーブルなので PostgREST (anon / authenticated) から閉じる
REVOKE ALL ON TABLE "Announcement" FROM anon, authenticated;
