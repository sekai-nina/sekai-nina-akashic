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
| `DISCORD_BOT_TOKEN` | Discord bot トークン | bot 使用時 |
| `DISCORD_CLIENT_ID` | Discord アプリ Client ID | bot 使用時 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | GCP サービスアカウント JSON | Drive 連携時 |
| `GOOGLE_DRIVE_FOLDER_ID` | アップロード先フォルダ ID | Drive 連携時 |

## Discord Bot

### Bot の作成

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリを作成
2. Bot を有効化し、トークンを取得
3. OAuth2 → URL Generator で `bot` と `applications.commands` スコープを選択
4. Permissions: `Send Messages`, `Read Message History`, `Attach Files`
5. 生成した URL でサーバーに招待
6. `.env` に `DISCORD_BOT_TOKEN` と `DISCORD_CLIENT_ID` を設定

### Bot の起動

```bash
pnpm bot
```

### 使い方

- **スラッシュコマンド**: `/akashic` — 直前のメッセージを Akashic に登録
- **コンテキストメニュー**: メッセージ右クリック → 「Akashicに登録」

登録後、編集用 URL が返されます。

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

Drive 未設定でもシステムは正常に動作します。Discord 添付ファイルは Discord の URL で保存されます。

## 開発

```bash
pnpm dev          # Next.js 開発サーバー
pnpm bot          # Discord bot
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
├── lib/
│   ├── actions.ts    # Server Actions
│   ├── auth.ts       # NextAuth 設定
│   ├── db.ts         # Prisma client
│   ├── domain/       # ビジネスロジック
│   ├── search/       # 検索サービス
│   ├── drive/        # Google Drive 連携
│   └── similarity/   # 類似検索（将来用）
└── bot/              # Discord bot
```
