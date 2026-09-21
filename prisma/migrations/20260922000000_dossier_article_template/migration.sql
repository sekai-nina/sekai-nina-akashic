-- ドシエに記事テンプレートと除外キーを持たせる (#169 / #170)
--
-- 記事はどれも「ドシエに素材を集める → 記事にする」の流れだが、Akashic 内で完結しているのは
-- ミーグリ (MeetGreet) だけで、おでかけ・言葉・属性は sekai-nina-site 側のスキルで手作業だった。
-- 「テンプレート + 決定的な組み立て + (必要なら) AI 本文」で統一するため、器 (MeetGreet / Live)
-- を持たないドシエが自分で「どの型の記事になるか」を持つ。
--
-- - `articleTemplate`: 記事の型。null は未設定で、記事にするときに選ぶ。MeetGreet / Live に
--   紐づくドシエは作成時に meetgreet / live が入る (既存行はアプリ側で追随させない。
--   MeetGreet / Live のリレーションが真なので、テンプレートの解決はリレーションを優先する)
-- - `articleExclusions`: 「記事に足さない」と決めたもののキー (#134)。器を持たないドシエが
--   記事の器になるときの置き場。形式は MeetGreet.articleExclusions と同じ
--
-- 既存テーブルへの列追加なので RLS ポリシーの変更は無く、GRANT も不要 (テーブル単位で付与済み)。

-- CreateEnum
CREATE TYPE "ArticleTemplate" AS ENUM ('meetgreet', 'live', 'outing', 'quote_blog', 'quote_situational', 'attribute');

-- AlterTable
ALTER TABLE "Dossier" ADD COLUMN     "articleExclusions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "articleTemplate" "ArticleTemplate";
