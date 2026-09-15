# Sekai Nina Akashic — アーキテクチャ

坂井新奈（日向坂46）に関する内部向けアーカイブ・検索システム。多様な情報（テキスト、画像、動画、音声、ドキュメント）を Asset 単位で蓄積し、あとから素早く検索・整理できることを最優先とする。

このドキュメントは **設計の「なぜ」** を残すためのもの。日々の作業に必要な事実（コマンド、規約、テーブル一覧）は `CLAUDE.md` を、認可の詳細は `docs/security-dev.md` を、API 仕様は `docs/api.md` を正とする。

## 技術スタック

| レイヤー | 技術 |
|---|---|
| 言語 | TypeScript（`strict: true`） |
| パッケージマネージャ | pnpm |
| Web フレームワーク | Next.js 16（App Router / Turbopack） |
| UI | React 19 + Tailwind CSS v4 + 手写しの UI 部品（`src/components/ui`） |
| DB | PostgreSQL（Supabase） |
| ORM | Prisma |
| 全文検索 | PGroonga |
| 認証 | Supabase Auth（`@supabase/ssr`）。招待制・MFA 全ユーザー必須 |
| AI 連携 | MCP サーバー（`POST /api/mcp`） |
| デプロイ | Vercel（region `hnd1` 固定） |

## 設計の核: クリアランスベースの RLS

このシステムは扱う情報に機密レベルの差がある。そのため **PostgreSQL の Row Level Security を認可の中心に据えている。**

- `ClearanceLevel` = `public` / `internal` / `confidential` / `restricted`
- 保護テーブルの各行が `classification` を持ち、ユーザーは `clearance` を持つ
- RLS ポリシーは `clearance_rank(classification) <= clearance_rank(current_setting('app.clearance'))`
- `clearance_rank()` は未知・未設定を `-1` にして **fail-closed**

アプリからは `withClearance(clearance, tx => …)` でトランザクションを開き、`set_config('app.clearance', …, true)` を通してから読み書きする。

### なぜアプリ層のフィルタではなく RLS か

条件を書き忘れた箇所が「見えてはいけないものを返す」のではなく「何も返さない」側に倒れるため。ただしこの設計には裏返しの罠がある —— **`app.clearance` を設定せずに保護テーブルへ触ると、エラーではなく無言で 0 行になる。** テストが無いため本番まで気づけない。CLAUDE.md が最重要ルールの筆頭に置いているのはこのため。

### 2 本の Prisma クライアント

| export | 接続 | RLS |
|---|---|---|
| `prisma` | `DATABASE_URL`（`app_runtime` ロール） | 適用 |
| `prismaInternal` | `DIRECT_URL`（`postgres` ロール） | バイパス |

バックアップ・リストア・全体統計は全行が見えないと成立しないので `prismaInternal` を使う。ユーザーに返すデータは必ず `withClearance` / `withSession` を通す。

**RLS は読みを守るが、自分より上のクリアランスを付けて書く操作は止められない。** そこはアプリ層（`src/lib/classification.ts` の `assertClearance`）で止める。既存レコードの機密レベルの**引き下げ**も RLS では止まらないため、API キー経由の再分類は引き上げのみに制限している。

## データモデル設計

`prisma/schema.prisma`（25 モデル）。`Asset` がハブ。

### 核心概念

- **Asset**: 元ファイルまたは元データの基本単位。画像・動画・テキスト等を統一的に扱う
- **AssetText**: Asset に紐づくテキスト情報（タイトル、本文、OCR 結果、書き起こし等）。検索の主要対象
- **Entity**: 人物・場所・出典・イベント・タグを統一管理
- **SourceRecord**: Asset の出典情報
- **Annotation**: Asset に対する人手注釈
- **Dossier**: 特定支援のための資料束（旧 `Collection`。RLS migration 等に旧名が残る）
- **Lens × DataSource**: 収集カバレッジ（後述）

### Asset と AssetText の分離

Asset は元データの管理単位、AssetText はそこから抽出・付与されたテキスト情報。この分離により:

- 1 つの Asset に複数種類のテキスト（タイトル、本文、OCR、書き起こし）を紐付けられる
- 検索結果として「どのテキストにヒットしたか」を明確にできる
- OCR・音声書き起こしを後から足せる

### Entity 設計

`type`（person / place / source / event / tag）で分類しつつ、すべて同一テーブルで管理する。

- UI 上は「タグを付ける」感覚で統一的に操作できる
- 内部では type ごとの絞り込みやスコアリングができる
- `aliases`（JSON 配列）で表記ゆれに対応する

`@@unique([type, canonicalName])`。`type: "place"` の Entity は `Place` と 1 対 1 で、`Place` 側だけが `classification` を持つ。

**Entity テーブル自体には実質的な RLS が無い**（ポリシーは `USING (true)` の素通し）。CLI のバックアップを含む多数の経路が素の `prisma` で触るため、DB 側で締めると無言で 0 行になる箇所が出るため。代わりに、ユーザーに Entity を返す経路はアプリ層の `entityClearanceWhere()` で `place` を絞る。

### Dossier の多態アイテム

`DossierItem` は `kind` で `asset_ref` / `external_link` / `external_image` を切り替える。**意図的に `@@unique([dossierId, assetId])` を持たない** —— 同一アセットを抜粋ごとに複数回追加できるようにするため。

### 収集カバレッジ

`Coverage` = `Lens`（観点）× `DataSource`（情報源）のマトリクス。`LensItemCheck` のアイテムは `DataSource.itemRule` から SourceRecord / Asset を**導出**する（実体化しない）。詳細は `docs/coverage-design.md`。

## 検索設計

`src/lib/search/index.ts` に閉じ込める。

### PGroonga を使う理由

当初は pg_trgm + ILIKE だったが、**RLS 下では `ILIKE`（`texticlike`）が leakproof でないため RLS ポリシーより先に評価できず、索引が使えない**。全件 Seq Scan になる。

PGroonga の `&@`（`pgroonga_match_text`）は leakproof なので、RLS を保ったまま索引が効く。日本語を扱うため `TokenNgram` + `NormalizerNFKC130` で索引を張っている（形態素解析ではなく n-gram なので部分一致が効く）。

### 検索対象フィールド

- `Asset.title` / `.description` / `.messageBodyPreview`
- `AssetText.normalizedContent`（`normalizeText()` が `{{IMG:…}}` の除去と空白圧縮まで済ませてあり、素の `content` より取りこぼしが少ない）
- `Entity.canonicalName` / `.normalizedName`（441 行しかないので pg_trgm + ILIKE のまま）

### 候補の束ね方

「タイトル等」「タグ名」「本文」を別々に LIMIT すると、マージ時に溢れた一致がどのページにも現れない。そのため候補を 1 つの UNION に束ね、`count(*) OVER ()` で総数も同時に取る。ただし窓関数の段は `id` / `rank` / ソート日付だけに絞る（表示用の列まで載せると 1 文字クエリで tuplestore が膨れる）。

### スコアリング

タイトル一致 > Entity 一致 > 本文一致 の重み付けで関連度順ソート。

### 日付の扱い

日付ドメインは JST。`canonicalDate` は「YYYY-MM-DD の UTC 00:00」で格納する規約で、範囲フィルタは**境界値のほうを JST に合わせてずらす**（列に `AT TIME ZONE` をかけると索引が効かなくなるため）。

## 認証・権限

- Supabase Auth。招待制で、**MFA が全ユーザー必須**（`src/middleware.ts` が未登録・未検証をリダイレクト）
- 3 ロール: `admin` / `member` / `viewer`
  - admin: ユーザー管理可
  - member: 登録・編集・ドシエ作成可
  - viewer: 閲覧と検索のみ
- ロールとクリアランスは直交する。ロールは「何ができるか」、クリアランスは「何が見えるか」
- 外部システム向けは API キー認証（`Authorization: Bearer ak_<64hex>`）。キーは `read` / `write` のパーミッションを持ち、クリアランスはキーの持ち主ユーザーのものを使う

## AI アシスタント連携（MCP）

`POST /api/mcp` に Model Context Protocol サーバーを載せている。認証は REST API と同じ API キー。

AI がツールを呼ぶ経路である以上、プロンプトインジェクションを前提に設計している:

- 作成したアセットは必ず `status: inbox` に入り、人間の仕分けを通る
- エンティティは名前で受けて**既存にしか紐づけない**（表記ゆれで重複を作らせない）
- 機密レベルの引き下げはできない
- 書き込みは `mcp.<tool>` として監査ログに残す

詳細は `docs/mcp.md`。

## Google Drive 連携

- OAuth2（個人ドライブ）またはサービスアカウント（共有ドライブ）の 2 方式
- 未設定でもシステム全体は動作する（`isDriveEnabled()` で任意化）
- 設定がある場合: ファイルを Drive にアップロードし、fileId と共有 URL を Asset に保存
- 未設定の場合: Discord attachment URL や手入力 URL を `storageUrl` として保存
- アセット作成・更新時に JSON を `akashic-backup/` へバックアップする

## 重複検出

- ファイルアップロード時に sha256 を計算し、同一ハッシュの既存 Asset があれば警告する
- Drive URL 手入力の場合は sha256 = null を許容
- 類似画像検索は将来対応（`src/lib/similarity/` にインターフェースのみ）

## 監査ログ

主要操作（Asset の作成・更新、Entity 追加、Dossier 作成、MCP 経由の書き込み）を `AuditLog` に記録する。MCP 経由は `actorId` だけでは人間の操作と区別できないため、`mcp.<tool>` という専用の action を別途残している。
