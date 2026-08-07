# Sekai Nina Akashic

世界新奈の内部向けアーカイブ・検索システム。

## セットアップ

### 必要なもの

- Node.js 22.12+
- pnpm
- Docker (PostgreSQL用)

### 手順

```bash
# 依存関係をインストール
pnpm install

# PostgreSQL を起動
docker compose up -d

# .env を作成
cp .env.example .env
# AUTH_SECRET を生成: openssl rand -base64 32

# マイグレーションを実行
pnpm db:migrate

# Prisma Client を生成
pnpm db:generate

# 初期データを投入
pnpm db:seed
```

### ローカル起動

```bash
# Web アプリを起動
pnpm dev
```

http://localhost:3000 にアクセス。

初期管理者アカウント:
- メール: `admin@akashic.local`
- パスワード: `admin123`

## `.env` 設定

| 変数 | 説明 | 必須 |
|------|------|------|
| `DATABASE_URL` | PostgreSQL 接続文字列 | ○ |
| `AUTH_SECRET` | NextAuth 署名キー | ○ |
| `AUTH_URL` | アプリの URL | ○ |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | GCP サービスアカウント JSON | Drive 連携時 |
| `GOOGLE_DRIVE_FOLDER_ID` | アップロード先フォルダ ID | Drive 連携時 |


## Google Drive 連携

### 設定方法

1. GCP プロジェクトで Google Drive API を有効化
2. サービスアカウントを作成し、JSON キーをダウンロード
3. Google Drive でアップロード先フォルダを作成
4. そのフォルダをサービスアカウントのメールアドレスと共有（編集権限）
5. `.env` に設定:

```
GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
GOOGLE_DRIVE_FOLDER_ID="your-folder-id"
```

Drive 未設定でもシステムは正常に動作します。

## 開発

```bash
pnpm dev          # Next.js 開発サーバー
pnpm db:studio    # Prisma Studio (DB GUI)
pnpm typecheck    # 型チェック
```

## アーキテクチャ

詳細は [docs/architecture.md](docs/architecture.md) を参照。

### ディレクトリ構成

```
src/
├── app/              # Next.js App Router
│   ├── (auth)/       # ログインページ
│   ├── (main)/       # 認証済みページ（サイドバー付き）
│   └── api/          # API routes
├── components/       # 共通コンポーネント
├── cli/              # tsx 実行スクリプト
└── lib/
    ├── actions.ts    # Server Actions
    ├── auth.ts       # NextAuth 設定
    ├── db.ts         # Prisma client
    ├── domain/       # ビジネスロジック
    ├── search/       # 検索サービス
    ├── drive/        # Google Drive 連携
    └── similarity/   # 類似検索（将来用）
```
