# 素材の「クリップ済」進捗 設計書 (#233)

記事化の手前、「この素材から記事になりうる情報をクリップし切ったか」を素材ごとに記録し、
データソースごとに **どこまで見たか・網羅できているか** を `/progress` で見えるようにする。

Issue: https://github.com/sekai-nina/sekai-nina-akashic/issues/233 (合意の経緯はコメント欄)

## なぜ

「どこまで見たか」の記録が 3 つに割れていて全体が見えない (2026-10-15 時点の本番の実数)。

| 仕組み | 単位 | 実態 |
|---|---|---|
| `/coverage` (`Lens` × `DataSource` の `LensItemCheck`) | アイテム × 9 観点 | 観点あたり約 18 件。2026-09-23 から止まっている (9 観点ぶん付けるのが細かすぎた) |
| `/progress` (`ArticleProgress`) | 回・ブログ × 反映先 | ひなあい・まだまだ・ひななり・ブログだけ。トーク・雑誌・ラジオに付ける場所が無い |
| `/clips` (クリップのプール) | 抜粋 | 素材を最後までクリップしたかは残らない |

記事化の入口もミーグリ・ライブ・ドシエでばらばらで、スナップ・おでかけ・状況つき言葉のテンプレートは本番で一度も使われていない (段階 2 で扱う)。

## 全体の段階

1. **進捗の一本化 (この設計書の主題)** — 全データソースの素材に「クリップ済」を付けられ、`/progress` で割合が見える
2. 流れの一本化 — 素材 → クリップ → ドシエ → テンプレート → 記事 → push。ミーグリ・ライブも記事生成はドシエ画面 (`/dossiers/[id]/article`) に寄せる
3. `/coverage` を公開サイトの鮮度表示だけに絞り、観点のアイテムチェックをやめる

段階 2・3 は段階 1 が入ってからユーザーと詰める。**段階 1 だけを 1 PR で作る。**

## 段階 1 の合意事項 (ユーザーと確定済み。変えるときは聞く)

1. **印は「クリップ済」1 つだけ。** 観点ごとには付けない。既存の `ArticleProgress` の `target = articles`「記事 済」(ひなあい 76 件など) とは**別の印**。読み替えて流用しない
2. **単位は「素材のまとまり」:**

   | データソース (`DataSource.key`) | 素材 1 件 | 一覧の作り方 |
   |---|---|---|
   | `blog` | ブログ 1 本 | 既存の `deriveItems` (`blog_url`) |
   | `talk` | トーク 1 日 (JST) | 既存の `deriveItems` (`talk_date`) |
   | `hinaai` / `ninarimashou` | 番組 1 回 | 既存の `deriveItems` (`source_url`)。まだまだは `hinaai` に含まれる |
   | `hinachan` / `official_ch` / `magazine` | 動画 1 本 / 雑誌 1 冊 | 既存の `deriveItems` (`source_url`) |
   | `instagram` / `tiktok` | 投稿・動画の URL | `itemRule` を `source_url` にし、`publisherPattern` を `Instagram` / `TikTok` にする (いま `manual`) |
   | `radio` | 放送 1 回 | **「ラジオ出演一覧」記事 (年度別 `【N年目】ラジオ出演一覧` を含む) の表の行**から導出 |
   | `showroom` / `x_official` | 登録済み SourceRecord の URL | アセット登録が前提。収集の仕組みが無いので当面は空で正しい |

3. **対象は全 12 データソース。**
4. **分母は「新奈に関係あるもの」だけ** = 本人著 ∪ 本文で言及あり。`/coverage` の判定 `getSourceAuthorKeys` / `getSourceMentionKeys` (`src/lib/domain/coverage-items.ts`) を流用する。トークは全件本人なので全部。判定が拾い漏らしたものは「その他」を開いて手で対象に入れられる (= 対象に入れた記録も持つ)
5. **ボタンは 2 か所:**
   - アセット詳細 (`src/app/(main)/assets/[id]/`、クリップを作る `references-panel.tsx` / `src/components/clip-dialog.tsx` の近く) に「この素材はクリップし切った」。トークのアセットから押すと**その日 (JST) 全体**に付く
   - `/progress` に全データソースのタブ。タブごとに済の割合、素材ごとの「クリップ数」と「済」トグル

```
/progress 「ブログ」タブ  62% 済
  秋ですね          クリップ 3  [✓ 済]
  旅行に行きました   クリップ 0  [ ]
```

## 実装の当たり (コードを読んで決めてよい部分)

- **保存先:** 新テーブル (例: `MaterialClipStatus { dataSourceKey, itemKey, status, … }`) を推奨。`ArticleProgress` は `materialKind` が番組とブログだけの enum で、番組は回番号・coverage は URL とキーが揃っていないため。どちらにするかは実装者の判断でよいが、PR 本文に理由を書く
  - `status` は少なくとも「済」と「対象に入れた (分母に足す)」を区別できること
  - 保護テーブルにする (`classification ClearanceLevel` + RLS 4 ポリシー + `ENABLE` / `FORCE`)。書き方は `/db-migration` スキル (`.claude/skills/db-migration/SKILL.md`)
- **素材の一覧:** `deriveItems` / `getDerivedItems` (`src/lib/domain/coverage.ts`) をそのまま使う。新しい導出を書くのはラジオだけ
  - ラジオの行の読み方は `src/lib/progress/list-row.ts` (出演一覧の表の行の規則) を参考に。ラジオ出演一覧の表の列は実記事で確認すること (`ARTICLES_DIR` の実ファイル)
- **クリップ数:** クリップはドシエ (`kind = clips` の 1 本) の `DossierItem` で、`assetId` を持つ。ドシエへ移したクリップも数える (= 全ドシエの `DossierItem` を素材のアセットで数える)。素材とアセットの対応は SourceRecord の URL / トークは JST の日付
- **既存の `/progress`:** `src/app/(main)/progress/` (タブは `progress-tabs.tsx`、番組は `src/lib/domain/show-progress.ts`)。既存のブログ → 言葉記事・番組の「出演一覧の行」「記事 済」はそのまま残し、「クリップ済」を足す
- **データの手当て (本番):** `instagram` / `tiktok` の `itemRule` / `publisherPattern` 変更は migration かデータ更新。`magazine` の `publisherPattern` は誌名の決め打ちで、publisher の末尾に `\n` が付いた行もある (`LIKE 'EX大衆%'` で拾えてはいる)。新しい誌が増えると漏れるので、気付いたら PR で触れる

## akashic のルール (CLAUDE.md の要点)

- **保護テーブルは必ず `withClearance` / `withSession` 経由。** 素の `prisma` は本番で無言の 0 行 (本番の `DATABASE_URL` は `app_runtime`)
- 新テーブルは本番適用後に `GRANT SELECT, INSERT, UPDATE, DELETE ON "<Table>" TO app_runtime;` が要る。migration 冒頭のコメントに書く
- `pnpm db:migrate` は必ず失敗する。`prisma migrate diff` → 手書き migration → `migrate deploy`
- 検証は `pnpm typecheck` と `pnpm test` (Node 22: `source ~/.nvm/nvm.sh && nvm use 22`)。lint は無い。`next build` は型エラーを無視するので代わりにならない
- 日付は JST。トークの日付バケットで過去に何度もずれている
- UI 文言・コメント・コミットメッセージは日本語。コミットは絵文字プレフィックス (`:dog2:` 機能 / `:ballet_shoes:` migration / `:fish:` 修正)。migration と実装はコミットを分ける
- 作業は worktree (`.claude/worktrees/feature-clip-progress`、ブランチ `feature/clip-progress`)。マージは squash
- **ユーザーの OK なしにしないこと:** コミット・push・PR のマージ・本番 DB への migration / データ書き込み・本番の環境変数変更・デプロイ
- 秘密情報 (DB の URL・Supabase の ref・API キー) を出力やコミットに出さない
- 機能追加時は `docs/` の該当設計書 (この文書) を同じ PR で更新する

## 段階 1 の実装 (2026-10-16)

### 画面・操作

- `/progress` は `/progress/materials/blog` へ遷移する。上段に全 12 ソースのクリップ進捗タブ、下段に従来の記事化タブを残す。
- `/progress/materials/[sourceKey]` に対象の済割合・素材ごとのクリップ数・済の付け外しを表示する。「その他」から手動で分母へ追加でき、自動対象でない素材は追加を取り消せる。50 件ずつ、日付の新しい順で表示する。
- アセット詳細のクリップ／参照パネル付近でも付け外しできる。トークは画像・本文など同日のアセットが同じ JST 日付キーを使う。
- 操作は admin / member の Server Action に限る。viewer は閲覧のみ。新しい REST / MCP API は追加しない。

### 保存先とキー

`MaterialClipStatus` を新設し、`(dataSourceKey, itemKey)` を一意にする。素材一覧そのものは保存せず、従来どおり導出する。

| カラム | 用途 |
|---|---|
| `dataSourceKey` | `DataSource.key` への外部キー |
| `itemKey` | URL / トークの JST 日付 / ラジオの `記事 shortId:行の #` |
| `done` | クリップ済の印。記事化の印とは独立 |
| `included` | 手動で分母に足した記録。済にすると同時に true。済を外しても残す |
| `classification` | ソースと対応アセットの見える範囲での最大機密レベル。更新で既存行を引き下げない |
| `updatedById`, `createdAt`, `updatedAt` | 操作者と更新日時 |

`ArticleProgress` は素材 enum・番組の回番号キー・反映先を前提とするため流用しない。`done` / `included` を分けることで、手動対象にした未完了素材を表現できる。手動対象を取り消す場合は `done` も false にする。既存の「記事 済」や LensItemCheck からの移行・読み替えはしない。

- 読み書きは `withClearance`、クリップ数の集計は所有者 RLS が要るため `withSession`。
- RLS は classification の SELECT / INSERT / UPDATE / DELETE の 4 ポリシーと ENABLE / FORCE。保存前にはキーを再導出し、`assertClearance` を通す。監査ログは `material.clip-progress`。
- 同一素材の保存は `(dataSourceKey, itemKey)` ごとのトランザクション advisory lock で直列化し、並行更新でも既存行の classification を下げない。
- 同日・同 URL に複数の機密レベルが混在すると、共有状態行の機密が下位利用者の閲覧範囲を超える場合がある。割合は閲覧できる進捗を基に計算し、非表示の状態を未済とは断定しない。保存が RLS / 一意制約で拒否された場合は内部情報を出さず専用の案内を表示し、その素材の操作を無効化する。上位状態の有無を追加照会したり、下位へ公開したりはしない。
- クリップ数はプールに限定せず、素材に属するアセットの `DossierItem(kind = asset_ref)` を数える。同じ URL の SourceRecord が複数あってもアセットを重複させない。非公開ドシエは閲覧権限に従うため、操作者によって件数が異なる。

### ラジオの導出とアセット対応

実記事は `sekai-nina-site/src/content/articles/event/` の「ラジオ出演一覧」と年度別 2 本を確認した。親記事は年度別記事へのリンクだけ、年度別の表は `# / 放送日 / 番組名 / 出演メンバー / 関連リンク`。1 年目 7 行・2 年目 1 行で、2025/7/11 に別番組が 2 行ある。

- DB の `Article.body` から同じ表を読み、年度別記事も対象とする。放送日だけではキーを作らない。`shortId:#` により別年度の同じ番号や同日の別番組を区別する。
- 出演一覧は本人の出演を記録した表なので全行が関連素材。アセット未登録でも素材として表示・済の記録ができる。
- アセットは表の関連リンク URL の一致、または JST 放送日と番組名の両方の一致で対応させる。SourceRecord のない録音も日付とタイトルが合えば一覧・詳細・機密継承の対象に含める。同日だけでは対応させない。対応できない録音は SourceRecord に表の出典 URL を持たせると紐づく。
- `shortId` と行の `#` は進捗のキーなので、既存行の番号を振り直すと対応が変わる。番組名・関連リンクの変更だけではキーは変わらない。

### migration と運用上の残り

`20261016000000_material_clip_status` は PR #234 のマージ後、ユーザーの承認を受けて **本番適用済み（GRANT 含む）**。SQL の作成時は本番接続を使わず、変更前後の Prisma schema 間の `migrate diff` で追加分を生成し、RLS とソース設定の UPDATE を追記した。

- migration 適用時に Instagram / TikTok を `source_url` + `Instagram%` / `TikTok%` へ変更する。末尾の改行を許容する前方一致。
- SHOWROOM は `source_url` + `SHOWROOM%`。X 公式は一般の X 言及と区別して `source_url` + `X（公式）%|X (公式)%|日向坂46公式X%`。今後アセット登録時にこの publisher 表記を使う（別表記の場合は DataSource 設定を追加）。未登録なら空で正しい。
- 同じ設定を `src/cli/seed-coverage.ts` に反映した。シードは実行していない。
- migration 冒頭の `GRANT SELECT, INSERT, UPDATE, DELETE ON "MaterialClipStatus" TO app_runtime;` も本番適用済み。適用履歴・RLS・実行時ロールの CRUD と下位／未設定 clearance の拒否を確認し、検証用データは残していない。
- magazine の既存 publisher リストは今回変えていない。新しい誌名が増えた際は DataSource 設定への追加が必要。
- 検証: `pnpm typecheck` 成功、`pnpm test` は 695 passed / 8 skipped（51 ファイル成功・2 ファイル skip）。追加テストはラジオの行・年度別キー・同日複数番組・トークの JST 境界・関連判定・手動対象の保持・件数の重複防止・機密ガードなどを扱う。
- ローカルの一時 PostgreSQL 17 に migration SQL を適用し、4 RLS ポリシー・ENABLE/FORCE・未設定/下位 clearance の拒否・許可された CRUD・4 ソース設定の更新・timestamp(3) の JST 日付境界を確認した。検証用コンテナは停止・削除済み。
- 実記事 3 本から 8 素材、2025/7/11 の別番組 2 件、キーの重複なしを確認した。
- 全12ソースの本番読み取り確認は成功。認証済みブラウザを使った実画面の操作確認は未実施。詳細とチェック手順は [段階2の設計案](./article-workflow-phase2-design.md) を参照。

## 完了条件 (段階 1)

- [x] 全 12 データソースのタブが `/progress` にあり、済の割合が出る
- [x] アセット詳細から「クリップ済」を付け外しでき、トークはその日全体に付く
- [x] 分母が「新奈に関係あるもの」になっていて、「その他」から手で対象に入れられる
- [x] 素材ごとのクリップ数が出る (ドシエへ移したクリップも数える)
- [x] `pnpm typecheck` / `pnpm test` が緑。素材の導出 (特にラジオの行・トークの JST 日付) にテストがある
- [x] migration は本番未適用のまま PR を出し、適用はユーザーの OK を取ってから

2026-10-16 の追加指示でコミット・push・PR 作成を承認済み。PR #234 はマージ済み。その後の追加承認で本番 migration・GRANT も適用済み。段階 2・3 は別の変更として扱う。

## 段階3の実装

観点別のアイテムチェックを終了し、`/coverage` を観点×ソースの確認済み日付の直接更新へ変更する。クリップ済とは別の印を維持する。詳細・検証・本番適用前の手順は [段階3の記録](./coverage-phase3-design.md)。本番 migration は未適用。
