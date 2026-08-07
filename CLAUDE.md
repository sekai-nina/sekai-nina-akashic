# CLAUDE.md — sekai-nina-akashic

坂井新奈（日向坂46）に関する内部向けアーカイブ・検索システム。Next.js 16 App Router + Prisma + Supabase (Postgres/Auth)。**クリアランス（機密レベル）ベースの RLS** が設計の核。

親ディレクトリの `hnt42-project/CLAUDE.md` の共通ルールも適用される。

## 最重要の 3 つ

1. **保護テーブルへのアクセスは必ず `withClearance` / `withSession` を通す。** 素の `prisma` で触ると **エラーではなく無言で 0 行**が返る。テストが無いので本番まで気づけない
2. **`pnpm typecheck` が唯一の静的ゲート。** lint 設定もテストも無く、`next.config.ts` は `typescript.ignoreBuildErrors: true`。**ビルドが通っても型は壊れうる**
3. **`pnpm db:migrate` は必ず失敗する。** マイグレーションは `/db-migration` スキルの手順で行う

## 開発フロー

実装は **Issue → worktree → 設計合意 → 実装 → レビュー → PR** の順で進む。各段階にスキルがある。

| 段階 | スキル |
|---|---|
| 起票 | `/issue` |
| ブランチ作成 | `/worktree create` |
| 設計合意 (3 ステップ以上のタスクは必須) | `/grill-me` |
| DB 変更 | `/db-migration` |
| コミット | `/commit` |
| レビュー | `/review` |
| PR 作成 | `/create-pr` |

- **worktree で作業する。** メインのワーキングツリー (`main`) を汚さない。`.claude/worktrees/` 配下、`origin/main` から分岐
- ブランチ: `feature/` / `fix/` / `chore/` + ケバブケース英語
- マージは **squash merge**。マージ済み判定に `git branch --merged` は使えない

## コマンド

パッケージマネージャは **pnpm** (`pnpm@10.28.2` 固定)。Node 22.12+。

```bash
pnpm dev              # 開発サーバー
pnpm typecheck        # 型チェック — 変更後は必ず実行
pnpm build            # prisma generate && next build
pnpm db:generate      # Prisma Client 再生成（schema 変更後に必須）
pnpm db:studio        # Prisma Studio
pnpm db:seed
pnpm bot              # Discord bot をローカル実行
```

`pnpm cli:*` は運用スクリプト群（`import` / `backup` / `restore` / `thumbnails` / `keygen` 等）。`src/cli/` 参照。

**lint / test スクリプトは存在しない。** 検証は `pnpm typecheck` + 実 DB への手動確認（`npx tsx -e '...'` で実データを叩く）。

## 認可モデル（このリポジトリの肝）

### 2 本の Prisma クライアント（`src/lib/db.ts`）

| export | 接続 | RLS |
|---|---|---|
| `prisma` | `DATABASE_URL`（`app_runtime` ロール, pooler:6543） | **適用**（`app.clearance` 未設定なら 0 行） |
| `prismaInternal` | `DIRECT_URL`（`postgres` ロール, 5432） | **バイパス** |

```ts
withClearance(clearance, tx => …)          // set_config('app.clearance')
withSession({ id, clearance }, tx => …)    // 上記 + app.user_id — Dossier 系に必須
```

| 状況 | 使うもの |
|---|---|
| ユーザーへのデータ返却 / CRUD | `withClearance` |
| Dossier 系（所有者判定が要る） | `withSession` |
| CLI・Bot・全体統計 | `prismaInternal` |
| `User` / `Entity` など非保護テーブル | 素の `prisma` |

- トランザクションの既定タイムアウトは **15,000ms**（Prisma 既定 5s だと重い集約が P2028 になるため引き上げ済み）
- RLS は読みを守るが、**自分より上のクリアランスを付けて書く操作はアプリ層で止める** → `src/lib/classification.ts` の `assertClearance`
- 生 SQL は `classificationFilterSql` を通す

### 保護テーブル

`Asset`, `AssetText`, `AssetEntity`, `AssetRelation`, `SourceRecord`, `Annotation`, `Testimonial`, `Dossier`, `Place`, `RepoCollection`, `Lens`, `DataSource`, `Coverage`, `LensItemCheck`

RLS は `clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))`。`clearance_rank()` は未知/未設定を `-1` にして **fail-closed**。全テーブル `ENABLE` + `FORCE ROW LEVEL SECURITY`。

### 認証

- Supabase Auth（`@supabase/ssr`）。招待制。**MFA 全ユーザー必須**（`src/middleware.ts` が未登録/未検証をリダイレクト）
- `auth()` は `React.cache` でリクエスト内 1 回、DB 引きは 5 分キャッシュ
- 外部システム向けは API キー認証（`Authorization: Bearer ak_<64hex>`）。`requireApiAuth(request, "read"|"write")` は **`ApiKeyUser | NextResponse` を返すので分岐が必須**
- AI アシスタント向けは MCP サーバー（`POST /api/mcp`）。認証は同じ API キーで、**キーの `permissions` によって `tools/list` に出るツールが変わる** → `docs/mcp.md`

## 構成

```
src/
├── app/
│   ├── (auth)/     # login, invite/[token], mfa/*
│   ├── (main)/     # 認証済みレイアウト（サイドバー付き）
│   └── api/        # 内部用 + api/v1/ (公開 REST, API キー認証)
├── components/     # 共通 + components/ui (shadcn 相当を手写し)
├── lib/
│   ├── db.ts, auth.ts, api-auth.ts, classification.ts, cache.ts
│   ├── actions.ts          # 汎用 Server Actions
│   ├── domain/             # ビジネスロジック（coverage, dossiers, assets, …）
│   ├── search/index.ts     # 検索サービス層
│   ├── mcp/                # MCP サーバー（ツール定義・射影・エンティティ解決）
│   └── r2/, drive/, thumbnails/, twitter/, supabase/, …
├── bot/            # Discord bot
├── cli/            # tsx 実行スクリプト
└── middleware.ts
```

主要ページ: `/search`（既定）, `/gallery`, `/assets`, `/inbox`, `/entities`, `/places`（聖地マップ）, `/dossiers`（特定支援）, `/testimonials`, `/repo`, `/coverage`, `/graph`, `/analysis`, `/dashboard`, `/admin/*`

## コード規約

- TypeScript `strict: true`、パスエイリアス **`@/* → ./src/*`**
- ファイル名は **kebab-case**（`coverage-panel.tsx`, `dossier-permissions.ts`）
- **コメント・UI 文言・コミットメッセージは日本語。** コード識別子は英語
- Server Actions: 汎用は `src/lib/actions.ts`、ページ固有は **コロケーション**（`(main)/coverage/actions.ts` 等）
- クライアント部品もページディレクトリ内に置く（`search/entity-filter.tsx` 等）
- 各ページに `loading.tsx` を置く
- 日本語ラベルは `src/lib/utils.ts` の `*_LABELS`（`ASSET_KIND_LABELS` 等）に集約する。画面に直書きしない
- キャッシュ無効化は `src/lib/cache.ts` の `invalidateAssets/Entities/Places/Dossiers` + `CACHE_TAGS`
- **日付は JST 基準で扱う。** UTC 起因のズレでバグを繰り返している（「今日まで反映」「アイテム導出の日付バケット」）

## データモデル

`prisma/schema.prisma`（26 モデル）。`Asset` がハブ。

- `Entity` は `type`（person/place/source/event/tag）で 1 テーブル統合、`@@unique([type, canonicalName])`
- `DossierItem` は `kind` で `asset_ref` / `external_link` / `external_image` の多態。**意図的に `@@unique([dossierId, assetId])` を持たない**（同一アセットを抜粋ごとに複数回追加できる）
- `Coverage` = `Lens`(観点) × `DataSource`。`LensItemCheck` のアイテムは `DataSource.itemRule` から SourceRecord/Asset を**導出**（実体化しない）
- `ClearanceLevel` = public / internal / confidential / restricted
- **`Collection` は `Dossier`（特定支援）に置き換え済み。** 旧名が RLS migration 等に残っている

検索は **pg_trgm + ILIKE**。PGroonga は導入後に撤去済み（`20260428000000_drop_pgroonga`）。

## 外部サービス

| サービス | 用途 | 備考 |
|---|---|---|
| Supabase | Auth + Postgres | `src/lib/supabase/{client,server,admin}.ts` |
| Cloudflare R2 | サムネイル等 | S3 互換。`isR2Configured()` で任意化 |
| Google Drive | 画像ソース | OAuth2（個人）/ サービスアカウント（共有ドライブ）の 2 方式 |
| Discord | `/akashic` コマンド + 「Akashicに登録」 | VPS 上で pm2 (`akashic-bot`) |
| X (Twitter) | recent search | 有料プラン必須 |
| OpenAI | 口コミ抽出（Structured Outputs） | |

環境変数は `.env.example` 参照。必須は `DATABASE_URL` / `DIRECT_URL` / `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY`。

ローカル DB は `docker-compose.yml`（MeCab ユーザー辞書同梱）。

## デプロイ

- **Web: Vercel**。`vercel.json` で **region `hnd1` 固定**（Supabase ap-northeast-1 とのコロケーション。既定の iad1 だとページ読み込みが 5-8 秒かかった）
- **Bot: VPS + pm2**。`.github/workflows/deploy.yml` が push to `main` で `pnpm typecheck` → SSH で `pm2 restart akashic-bot`
- `instrumentation.ts` が起動時に Prisma を事前接続（pooler の ~800ms コールドコネクト回避）

## ドキュメント

| ファイル | 内容 |
|---|---|
| `docs/security-dev.md` | **開発者向け鉄則。認可まわりはこれが正** |
| `docs/api.md` | REST API v1 の完全仕様 |
| `docs/mcp.md` | MCP サーバー（`/api/mcp`）の仕様と設計判断 |
| `docs/coverage-design.md` | 収集カバレッジ設計書 |
| `docs/security.md` / `docs/security-admin.md` | 非エンジニア / 管理者向け |
| ~~`docs/architecture.md`~~ | **陳腐化**（Next.js 15 / NextAuth / Collection の記述）。参照しない |

機能追加時は `docs/api.md` と該当設計書を **同じ PR で更新する**のが慣習。

## コミット

絵文字プレフィックス必須。詳細は `/commit` スキル。

| 絵文字 | 用途 |
|---|---|
| `:dog2:` | 機能追加・改善 |
| `:fish:` | バグ修正・挙動修正 |
| `:balloon:` | パフォーマンス改善・インフラ/設定変更・リファクタ |
| `:icecream:` | ドキュメント更新 |
| `:ballet_shoes:` | DB スキーマ・マイグレーション |

`:bug:` は過去の表記。現在は `:fish:` に統一。
