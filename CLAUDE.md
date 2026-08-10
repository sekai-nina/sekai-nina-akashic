# CLAUDE.md — sekai-nina-akashic

坂井新奈（日向坂46）に関する内部向けアーカイブ・検索システム。Next.js 16 App Router + Prisma + Supabase (Postgres/Auth)。**クリアランス（機密レベル）ベースの RLS** が設計の核。

親ディレクトリの `hnt42-project/CLAUDE.md` の共通ルールも適用される。

## 最重要の 3 つ

1. **保護テーブルへのアクセスは必ず `withClearance` / `withSession` を通す。** 素の `prisma` で触ると **エラーではなく無言で 0 行**が返る。認可まわりのテストは無いので本番まで気づけない
2. **静的ゲートは `pnpm typecheck` と `pnpm test` の 2 つ。** lint 設定は無く、`next.config.ts` は `typescript.ignoreBuildErrors: true`。**ビルドが通っても型は壊れうる**。テストは記事の frontmatter 往復 (`src/lib/articles/`) しか無いので、それ以外は依然として実 DB で確かめるしかない
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
pnpm test             # vitest。変更後は typecheck とあわせて実行
```

`pnpm cli:*` は運用スクリプト群（`import` / `backup` / `restore` / `thumbnails` / `keygen` 等）。`src/cli/` 参照。

**lint スクリプトは存在しない。** 検証は `pnpm typecheck` + `pnpm test` + 実 DB への手動確認（`npx tsx -e '...'` で実データを叩く）。

テストは **vitest**（`vitest.config.mts`）。現状の対象は記事の frontmatter 往復のみ:

```bash
pnpm test                                                    # 合成ケースのみ
ARTICLES_DIR=<sekai-nina-public のパス> pnpm test              # 実記事 332 件も検証
```

記事の実体は別リポジトリなので、`ARTICLES_DIR` が未設定なら実記事のテストは skip される（CI はこの状態で回る）。**記事の push（#46）を触る前には `ARTICLES_DIR` 付きで緑にしておく。**

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
| CLI・全体統計 | `prismaInternal` |
| `User` / `Entity` など非保護テーブル | 素の `prisma` |
| `Entity` を**一覧・検索で返す**とき | `listEntities` / `searchEntities` / `getEntityById`（後述） |

- トランザクションの既定タイムアウトは **15,000ms**（Prisma 既定 5s だと重い集約が P2028 になるため引き上げ済み）
- RLS は読みを守るが、**自分より上のクリアランスを付けて書く操作はアプリ層で止める** → `src/lib/classification.ts` の `assertClearance`
- 生 SQL は `classificationFilterSql` を通す

#### `Entity` の place だけはクリアランスで絞る

`Entity` の RLS ポリシーは `USING (true)` の素通しなので、`type: "place"` のエンティティは**紐づく `Place` が上位機密でも名前と説明が誰にでも列挙できる**（`Place` 側の RLS は Place 行しか守らない）。

`Entity` は CLI のバックアップを含め 30 箇所以上から素の `prisma` で触られており、DB 側のポリシーを締めると `app.clearance` 未設定の経路が無言で 0 行になる（= バックアップから聖地が欠落する）。加えて索引も効かなくなる。そのため**アプリ層で塞いでいる** → `src/lib/domain/entities.ts` の `entityClearanceWhere()`。

ユーザーに Entity を返す経路（`listEntities` / `searchEntities` / `getEntityById` / `src/lib/cache.ts` の `getCachedEntity*`）はすべてこれを通す。`entityClearanceWhere` は **`withClearance` の中でしか使えない**（素の `prisma` から使うと `Place` の RLS で全 place エンティティが消える）。

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

検索は **PGroonga**（`&@` 演算子）。トークナイザは `TokenNgram`（`unify_alphabet` / `unify_digit` / `unify_symbol` をすべて無効）、ノーマライザは `NormalizerNFKC130`。

- **ILIKE は RLS 下でインデックスが効かない。** `texticlike` が leakproof でないため RLS ポリシーより先に評価できず、必ず Seq Scan になる。PGroonga のマッチ演算子は leakproof なので RLS を保ったまま索引が使える（`20260807000000_add_pgroonga_indexes`）
- **PGroonga 索引を張った列では `ILIKE` も PGroonga 経由になる。** トークナイザ設定を誤ると `&@` だけでなく既存の ILIKE クエリまで取りこぼす。索引を張った列に ILIKE を当てる箇所（`getTextMatches` 等）は列を `(col || '')` で包んで素の ILIKE に落としてある
- 索引がある列: `Asset.title` / `.description` / `.messageBodyPreview`、`AssetText.normalizedContent`。`Entity` は 441 行しかないので pg_trgm + ILIKE のまま
  - `20260807010000_drop_trgm_indexes` のコメントは「`Entity` は RLS 対象外」と書いているが**誤り**。`Entity` にも RLS は張られていて、ポリシーが `USING (true)` なので security qual が実質消えて索引が効いているだけ。ポリシーを非自明な条件に締めた瞬間、ILIKE は無言で Seq Scan に戻る
- **PGroonga 索引は `pg_relation_size` が 0 bytes、`pg_stat_user_indexes.idx_scan` も増えない。** 実体を Groonga がヒープ外に持つため。未使用インデックスの棚卸しで誤って削除候補に挙げないこと
- ILIKE との一致は `pnpm cli:verify-pgroonga` で突き合わせる

## 外部サービス

| サービス | 用途 | 備考 |
|---|---|---|
| Supabase | Auth + Postgres | `src/lib/supabase/{client,server,admin}.ts` |
| Cloudflare R2 | サムネイル等 | S3 互換。`isR2Configured()` で任意化 |
| Google Drive | 画像ソース | OAuth2（個人）/ サービスアカウント（共有ドライブ）の 2 方式 |
| X (Twitter) | recent search | 有料プラン必須 |
| OpenAI | 口コミ抽出（Structured Outputs） | |

環境変数は `.env.example` 参照。必須は `DATABASE_URL` / `DIRECT_URL` / `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY`。

ローカル DB は `docker-compose.yml`（MeCab ユーザー辞書同梱）。

## デプロイ

- **Web: Vercel**。`vercel.json` で **region `hnd1` 固定**（Supabase ap-northeast-1 とのコロケーション。既定の iad1 だとページ読み込みが 5-8 秒かかった）
- **CI**: `.github/workflows/ci.yml` が push to `main` で `pnpm typecheck` を回すだけ（Discord bot は撤去済み）
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
