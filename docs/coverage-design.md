# 収集カバレッジ管理（観点 × データソース）設計書

Status: 設計確定（2026-07-12）/ 実装未着手
Owner: tada / 設計: Claude (Fable 5)

## 1. 目的・背景

世界新奈（サイト・vault・Akashic）を「最新状態に保つ」作業が管理不能になっている。
「今どこまで見たのか」「何が足りていないのか」が分からない。

そこで **最新状態の基準** を導入する:

> 情報収集の「観点」のリストを定義し、各データソースに対して
> 「その観点を **何日の分まで** 適用（収集）したか」を記録する。
> 全ての有効な (観点 × データソース) セルが十分新しい日付まで埋まっていれば、
> 世界新奈は最新である。

方針決定事項（ユーザー確認済み）:
- カーソルは **日付**（YYYY-MM-DD）。「この日まで反映済み」の1点のみ。
- 軸は **観点 × データソース の2軸**（対象は坂井新奈のみ。人物軸は持たない）。
- ソースごとの「フロンティア日付」との自動比較は**やらない**。
  表示は素直に「◯月◯日まで反映できています」でよい（経過日数の色付けは補助表示として可）。
- サイト（公開側）にも **控えめに** 鮮度を表示する。内部メモは公開しない。

## 2. 概念定義

| 概念 | 意味 | 例 |
|---|---|---|
| **Lens（観点）** | 情報収集の切り口。名前＋詳細説明。後から自由に追加 | ライブ, ミーグリ, 食べたもの, 所有物, レジャー(おでかけ), インプット, 新奈メモ, 良い言葉, 面白い返答 |
| **DataSource（データソース）** | 収集元のストリーム | ブログ, トーク, 日向坂で会いましょう, … |
| **Coverage（カバレッジ）** | セル。「Lens を DataSource に collectedUntil まで適用済み」 | (食べたもの × ブログ) = 2026-06-25 まで |

セルの3状態:
- **行が存在し tracked** … collectedUntil まで収集済み
- **行が存在し not_applicable** … この組み合わせは対象外（マトリクスでグレー表示）
- **行が存在しない** … 未着手（＝ギャップとして目立たせる）

## 3. データモデル（Prisma 追加分）

> **実装済み（Phase 1・2026-07-12）**。レビュアー決定により当初案から以下を変更:
> - Lens / DataSource / Coverage の3モデル全てに `classification ClearanceLevel @default(internal)` を追加（既存 enum を使用）。
> - RLS は Place / RepoCollection と**同一の direct-classification パターン**（ENABLE + FORCE、app_runtime 向け select/insert/update/delete の4ポリシー、`clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))`）を**新テーブル作成と同じ migration 内で**張る（`20260712000000_coverage`）。過去に RLS 忘れで PostgREST 公開事故があったための絶対条件。
> - `public` boolean（公開サイトの鮮度表示に出すか）は classification とは別関心事としてそのまま保持。

```prisma
enum DataSourceKind {
  blog
  talk
  tv
  youtube
  sns
  radio
  magazine
  live_event
  other
}

enum CoverageStatus {
  tracked
  not_applicable
}

model Lens {
  id             String         @id @default(cuid())
  key            String         @unique // 機械名: live, meetgreet, food, possessions, ...
  name           String // 表示名: ライブ, ミーグリ, 食べたもの, ...
  description    String // 観点の詳細説明（何を拾うか・拾わないか）
  sortOrder      Int            @default(0)
  active         Boolean        @default(true)
  public         Boolean        @default(true) // 公開サイトの鮮度表示に出すか
  classification ClearanceLevel @default(internal)
  coverages      Coverage[]
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt

  @@index([classification])
}

model DataSource {
  id             String         @id @default(cuid())
  key            String         @unique // blog, talk, hinaai, hinachan, ...
  name           String
  kind           DataSourceKind
  description    String?
  sortOrder      Int            @default(0)
  active         Boolean        @default(true)
  public         Boolean        @default(true)
  classification ClearanceLevel @default(internal)
  coverages      Coverage[]
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt

  @@index([classification])
}

model Coverage {
  id             String         @id @default(cuid())
  lensId         String
  lens           Lens           @relation(fields: [lensId], references: [id], onDelete: Cascade)
  dataSourceId   String
  dataSource     DataSource     @relation(fields: [dataSourceId], references: [id], onDelete: Cascade)
  status         CoverageStatus @default(tracked)
  collectedUntil DateTime? // 日付として扱う（YYYY-MM-DD）。not_applicable なら null
  note           String? // 内部メモ（公開しない）
  classification ClearanceLevel @default(internal)
  updatedById    String?
  updatedAt      DateTime       @updatedAt
  createdAt      DateTime       @default(now())

  @@unique([lensId, dataSourceId])
  @@index([dataSourceId])
  @@index([classification])
}
```

設計判断:
- `collectedUntil` は DateTime だが**日単位の運用**（API/UI では YYYY-MM-DD に正規化。ドメイン層で UTC 00:00 に固定して TZ 事故を回避）。
- `classification` は3モデル各自が保持し、RLS で clearance ベースに絞る（fail-closed）。`updatedById` は User への FK を張らず文字列で保持（監査は AuditLog 側で担保）。
- 既存モデル（Asset / SourceRecord / RepoCollection）への変更は**しない**。
  将来 Phase 3 で「そのソースの最大 canonicalDate」等を参考表示する場合も read-only 参照に留める。
- 更新の監査は既存 `AuditLog`（action: `coverage.update` / `lens.create` / `lens.update` / `datasource.create` / `datasource.update`）に記録。

## 4. 初期シード

### Lens（sortOrder 順）

| key | name | description（要旨・シード時に加筆可） |
|---|---|---|
| leisure | レジャー（おでかけ） | 誰かと出かけた出来事。場所・同行者・行動の事実 |
| meetgreet | ミーグリ | オンライン/リアルミーグリの実施回・レポ・本人感想 |
| live | ライブ | 参加・出演したライブ、披露曲、現場での出来事 |
| input | インプット | 観た映画・ドラマ・読んだ本などの摂取コンテンツ |
| food | 食べたもの | 食べた・飲んだものの記録 |
| possessions | 所有物 | 私物・愛用品・購入したもの |
| nina_memo | 新奈メモ | 坂井新奈に関する細かい知識・属性・エピソード |
| good_words | 良い言葉 | ブログ・トーク内の印象的な言葉・名言 |
| funny_replies | 面白い返答 | ミーグリ・配信等での面白い返答・やりとり |

### DataSource

| key | name | kind |
|---|---|---|
| blog | 公式ブログ | blog |
| talk | トーク（メッセージ） | talk |
| hinaai | 日向坂で会いましょう | tv |
| hinachan | 日向坂ちゃんねる | youtube |
| ninarimashou | 日向坂になりましょう | tv |
| official_ch | 日向坂46公式チャンネル | youtube |
| instagram | Instagram | sns |
| tiktok | TikTok | sns |
| x_official | X（公式） | sns |
| showroom | SHOWROOM | sns |
| radio | ラジオ（radiko） | radio |
| magazine | 雑誌 | magazine |

- 粒度は上記で確定（TV は番組単位）。追加・無効化は UI から。
- セルは**シードで全組み合わせを作らない**。未着手セルは行なしで表現し、
  UI から「tracked（日付入力）」「not_applicable」を明示的に作る。

## 5. API（Akashic `/api/v1/`）

既存の ApiKey 認証（Bearer / permissions 配列）に乗せる。

| エンドポイント | メソッド | 権限 | 内容 |
|---|---|---|---|
| `/api/v1/lenses` | GET / POST | read / write | 観点一覧・作成 |
| `/api/v1/lenses/[id]` | PATCH / DELETE | write | 編集（DELETE は active=false 化でも可） |
| `/api/v1/datasources` | GET / POST | read / write | ソース一覧・作成 |
| `/api/v1/datasources/[id]` | PATCH / DELETE | write | 編集 |
| `/api/v1/coverage` | GET | read | マトリクス全体。`?public=1` で public な行列のみ＋note 除去 |
| `/api/v1/coverage` | PUT | write | セル upsert `{lensKey, dataSourceKey, status, collectedUntil, note}` |
| `/api/v1/coverage/summary` | GET | read | サイト用の要約（下記） |

`GET /api/v1/coverage/summary`（public 前提の形; note なし）:

```json
{
  "generatedAt": "2026-07-12T…",
  "lenses": [
    {
      "key": "food", "name": "食べたもの",
      "sources": [
        {"key": "blog", "name": "公式ブログ", "collectedUntil": "2026-06-25"},
        {"key": "talk", "name": "トーク", "collectedUntil": "2026-05-30"}
      ],
      "minCollectedUntil": "2026-05-30"
    }
  ]
}
```
- `minCollectedUntil` = その観点の中で最も遅れているソースの日付（「この観点は少なくともここまでは反映済み」の1行表示に使う）。
- not_applicable と行なし（未着手）は summary に含めない（公開表示の対象外）。
  未着手は内部マトリクスでのみギャップとして見せる。

## 6. Akashic UI（`src/app/(main)/coverage/page.tsx`）

- **マトリクス表示**: 行=Lens、列=DataSource。セル内容:
  - tracked → `YYYY-MM-DD`（補助として経過日数を淡色表示。例: 「2026-06-25（17日前）」）
  - not_applicable → グレー「—」
  - 行なし → 空セル（枠線強調。クリックで作成）
- **セル編集**: クリックでポップオーバー（日付ピッカー＋status＋note）。日付だけの更新は1クリック＋1入力で済むこと（運用頻度が高い）。
- **「今日まで反映した」ボタン**: セル/行単位で collectedUntil=today にする一括操作（実運用の主動線）。
- **観点・ソース管理**: 同ページ内タブまたは `/coverage/settings` で CRUD（key は作成後変更不可）。
- 権限: admin / member は編集可、viewer は閲覧のみ（既存 Role に従う）。

## 7. サイト側（sekai-nina-site, Phase 2）

既存の sync パターン（sync-places / sync-sources と同型）:

1. `scripts/sync-coverage.ts` → `GET /api/v1/coverage/summary` → `data/coverage.json`
   （`pnpm sync:coverage`。ビルド前に手動 or デプロイフローで実行）
2. 表示（控えめに）:
   - `/status`（新設・「アーカイブの反映状況」）: 観点ごとに
     「**食べたもの** — 公式ブログ: 2026-06-25まで / トーク: 2026-05-30まで」の一覧。
     冒頭に「このアーカイブは観点ごとに下記の日付まで各ソースを確認・反映しています」の説明。
   - フッターに1行バッジ:「アーカイブ反映状況 → /status」（数値はページ側に集約。フッターで日付までは出さない）
3. アラート的表現はしない。日付の提示のみ（見る側が判断できれば十分）。
   ※経過日数での淡い色分けは `/status` 内の補助表示として任意実装。

## 8. 運用フロー

- **人間（当面の主フロー）**: ソースを見て観点の情報を拾う作業をしたら、Akashic の
  マトリクスで該当セルを「今日（またはどこまで見たかの日付）」に更新。
- **bot / パイプライン（将来 Phase 3）**:
  - ドシエ→記事生成やレポ取り込みが完了したら該当セルを API 経由で自動前進
    （例: ミーグリ記事生成完了 → (meetgreet × blog/talk) を当該日まで）。
  - `check-dossier-updates.ts`（実装済み）と同様に cron から `coverage` を読み、
    長期停滞セルを Discord 通知（sekai-nina-discord-bot）。

## 9. フェーズ分割と実装タスク（委任用）

実装は Opus 等の実装エージェントに委任可能な粒度で分割:

### Phase 1: Akashic 中核（このリポジトリ）
1. **migration**: 上記 3 モデル＋2 enum を schema.prisma に追加、`prisma migrate dev`
2. **seed**: `src/cli/seed-coverage.ts` — Lens 9 件・DataSource 12 件（セルは作らない）
3. **domain**: `src/lib/domain/coverage.ts` — 一覧/upsert/summary のロジック（日付正規化含む）
4. **API**: `/api/v1/lenses` `/api/v1/datasources` `/api/v1/coverage` `/api/v1/coverage/summary`
   （既存 `api-auth.ts` の permissions 準拠、AuditLog 記録）
5. **UI**: `(main)/coverage/page.tsx` マトリクス＋セル編集＋「今日まで反映」＋観点/ソース管理
6. docs: `docs/api.md` にエンドポイント追記

受け入れ基準: マトリクスでセルを編集でき、`GET /coverage/summary` が期待 JSON を返す。
`pnpm lint` / `tsc` / 既存テストが通る。

### Phase 2: サイト連携（sekai-nina-site）
1. `scripts/sync-coverage.ts` ＋ `pnpm sync:coverage` ＋ `data/coverage.json`
2. `/status` ページ＋フッター導線（BaseLayout）
3. `astro check` / build 通過

### Phase 3: 自動化（任意・後日）
- 生成パイプラインからのセル自動前進 / Discord 停滞通知 / 参考情報として
  ソース別最大 `canonicalDate` の並記

## 10. 非スコープ（明示）

- 人物軸（坂井新奈以外への横展開）
- フロンティア日付との自動突合・「最新/非最新」の機械判定
- ソース内アイテム単位（1記事ずつ）の既読管理 — カーソルは日付1点のみ
