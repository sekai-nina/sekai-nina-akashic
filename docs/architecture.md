# Sekai Nina Akashic — アーキテクチャ

## 概要

内部向けアーカイブ・検索システム。多様な情報（テキスト、画像、動画、音声、ドキュメント）を Asset 単位で蓄積し、あとから素早く検索・整理できることを最優先とする。

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| 言語 | TypeScript |
| パッケージマネージャ | pnpm |
| Web フレームワーク | Next.js 15 (App Router) |
| UI | React + Tailwind CSS + shadcn/ui |
| DB | PostgreSQL 16 |
| ORM | Prisma |
| 認証 | NextAuth (Auth.js v5) credentials |
| Discord bot | discord.js |
| 開発環境 | Docker Compose (PostgreSQL) + Next.js dev server |

## ディレクトリ構成

```
sekai-nina-akashic/
├── docs/                     # ドキュメント
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts
│   └── migrations/
├── src/
│   ├── app/                  # Next.js App Router pages
│   │   ├── (auth)/           # ログイン等の認証ページ
│   │   ├── (main)/           # 認証済みレイアウト（サイドバー付き）
│   │   │   ├── inbox/
│   │   │   ├── assets/
│   │   │   ├── search/
│   │   │   ├── collections/
│   │   │   └── admin/
│   │   └── api/              # API routes
│   ├── components/           # 共通 UI コンポーネント
│   ├── lib/
│   │   ├── db.ts             # Prisma client singleton
│   │   ├── auth.ts           # NextAuth 設定
│   │   ├── domain/           # ビジネスロジック
│   │   ├── search/           # 検索サービス層
│   │   ├── drive/            # Google Drive 連携
│   │   └── similarity/       # 将来の類似検索用インターフェース
│   └── bot/                  # Discord bot
│       ├── index.ts
│       ├── commands/
│       └── handlers/
├── docker-compose.yml
├── .env.example
└── README.md
```

## データモデル設計

### 核心概念

- **Asset**: 元ファイルまたは元データの基本単位。画像、動画、テキスト等を統一的に扱う
- **AssetText**: Asset に紐づくテキスト情報（タイトル、本文、OCR結果、書き起こし等）。検索の主要対象
- **Entity**: 人物・場所・出典・イベント・タグを統一管理。UI 上はタグ感覚で使える
- **SourceRecord**: Asset の出典情報
- **Annotation**: Asset に対する人手注釈
- **Collection**: ユーザー単位の資料束

### Asset と AssetText の分離

Asset は元データの管理単位、AssetText はそこから抽出・付与されたテキスト情報。この分離により：
- 1つの Asset に複数種類のテキスト（タイトル、本文、OCR、書き起こし）を紐付けられる
- 検索結果として「どのテキストにヒットしたか」を明確にできる
- 将来の OCR・音声書き起こし追加が容易

### Entity 設計

Entity は type フィールド（person/place/source/event/tag）で分類しつつ、すべて同一テーブルで管理する。これにより：
- UI 上は「タグを付ける」感覚で統一的に操作できる
- 内部では type ごとの絞り込みやスコアリングが可能
- aliases (JSON 配列) で表記ゆれに対応

## 検索設計

### MVP の検索戦略

PostgreSQL ベースで以下を組み合わせる：

1. **pg_trgm (トライグラム)**: あいまい検索の中核。日本語でも実用的に動作する
2. **ILIKE**: 部分一致検索
3. **正規化テキスト**: normalizedContent フィールドに正規化済みテキストを保持し、検索精度を向上

### 検索対象フィールド

- `Asset.title`, `Asset.description`, `Asset.messageBodyPreview`
- `AssetText.content`, `AssetText.normalizedContent`
- `Entity.canonicalName`, `Entity.aliases`, `Entity.normalizedName`

### スコアリング

タイトル一致 > Entity 一致 > 本文一致 の重み付けで関連度順ソート。

### 検索サービス層

`src/lib/search/` に検索ロジックを閉じ込め、将来 Elasticsearch/Meilisearch 等への差し替えを容易にする。

```typescript
interface SearchService {
  search(query: SearchQuery): Promise<SearchResult>;
}
```

## 認証・権限

- NextAuth credentials プロバイダーでメール/パスワード認証
- 3ロール: admin / member / viewer
- Server Actions / API routes でロールチェックを実施
- admin: ユーザー管理可
- member: 登録・編集・コレクション作成可
- viewer: 閲覧と検索のみ

## Google Drive 連携

- `GOOGLE_SERVICE_ACCOUNT_JSON` と `GOOGLE_DRIVE_FOLDER_ID` が設定されている場合のみ有効
- 未設定でもシステム全体は動作する
- 設定がある場合: ファイルを Drive にアップロードし、fileId と共有 URL を Asset に保存
- 未設定の場合: Discord attachment URL や手入力 URL を storageUrl として保存

## 重複検出

- ファイルアップロード時に sha256 を計算
- 同一ハッシュの既存 Asset がある場合は警告表示
- Drive URL 手入力の場合は sha256 = null 許容
- 類似画像検索は将来対応（`src/lib/similarity` にインターフェースのみ配置）

## 監査ログ

主要操作（Asset 作成/更新、Entity 追加、Collection 作成、Discord bot 登録）を AuditLog テーブルに記録。
