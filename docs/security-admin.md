# セキュリティ管理者ガイド

日常的な管理作業の手順。

## ユーザーの招待

1. サイドバーの **「招待管理」** をクリック
2. 「新規招待を作成」で以下を設定：
   - **メールアドレス** — 特定の人に限定する場合（省略可）
   - **ロール** — メンバー（編集可）/ 閲覧者（見るだけ）/ 管理者
   - **クリアランスレベル** — 一般 / 限定 / 極秘
   - **有効期間** — デフォルト 7 日
3. 「招待を作成」をクリック
4. 「リンクをコピー」で URL を取得
5. Discord 等で相手にリンクを送る
6. 相手がリンクを開いて Discord またはメールで登録

## ユーザーのクリアランス変更

1. サイドバーの **「ユーザー管理」** をクリック
2. 対象ユーザーの「編集」をクリック
3. **クリアランス** を変更して「保存」

注意：自分のクリアランスより高いレベルを他のユーザーに付与することはできません。

## アセットの機密レベル設定

- 新規作成時：機密レベルの指定がなければ、作成者のクリアランスレベルがデフォルト
- 編集時：アセット詳細ページの編集画面で変更可能
- API 経由：`classification` フィールドで指定（`internal`, `confidential`, `restricted`）

## トラブルシューティング

### 「データが表示されない」

クリアランスレベルが足りない可能性があります。管理者にクリアランスの引き上げを依頼してください。

### 「Discord でログインしたが入れない」

招待リンク経由で登録していない場合、アカウントが存在しません。管理者に招待リンクの発行を依頼してください。

### 「二段階認証のコードが通らない」

スマホの時刻がずれていると認証コードが合いません。端末の時刻を自動設定にしてください。

## 環境変数（デプロイ担当向け）

| 変数 | 説明 |
|------|------|
| `DATABASE_URL` | `app_runtime` ロールで接続（RLS 適用） |
| `DIRECT_URL` | `app_internal` ロールで接続（`prismaInternal` 用。RLS バイパス、テーブルの作成・変更・削除は不可）。Production / Preview とも Sensitive |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase プロジェクト URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase 公開キー（RLS で保護済み） |
| `SUPABASE_SECRET_KEY` | Supabase シークレットキー（サーバーサイドのみ） |

### `app_runtime` ロールのパスワード変更

```sql
-- Supabase SQL Editor で実行
ALTER ROLE app_runtime PASSWORD 'new_secure_password';
```

変更後、`DATABASE_URL` の接続文字列を更新し、アプリを再デプロイしてください。

### `app_internal` ロール（Vercel の `DIRECT_URL`）

Vercel のアプリは `postgres` ではなく `app_internal` でつなぐ（2026-10-25〜、#251）。行の読み書きと RLS バイパスはできるが、テーブル・スキーマの作成・変更・削除・TRUNCATE は DB が拒否する。手元の CLI 用の `akashic_cli` と同じ権限で、資格情報だけ分けている（片方が漏れたら片方だけ止められる）。作成時の SQL:

```sql
-- postgres で実行
CREATE ROLE app_internal LOGIN BYPASSRLS PASSWORD '...';
GRANT USAGE ON SCHEMA public TO app_internal;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_internal;
GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA public TO app_internal;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_internal;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO app_internal;
```

接続文字列のユーザー名は `app_internal.<プロジェクト ref>`（Supavisor 経由）。パスワードを変えたら `ALTER ROLE app_internal PASSWORD '...'` のあと、Vercel の `DIRECT_URL`（Production / Preview）を `vercel env add DIRECT_URL <env> --sensitive --force` で更新して再デプロイする。
