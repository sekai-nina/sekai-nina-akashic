---
name: review
description: 変更ファイルに対して複数のレビューサブエージェントを並列起動し、Critical / Warning / Suggestion で集約するワークフロー。PR 作成前や「レビューして」と言われたときに使う。
---

# Review

変更ファイルに対して **複数のサブエージェントを並列に起動** してコードレビューを実施する。

## 手順

### 1. 変更ファイルの収集

```bash
# ベースブランチからの差分 (PR 単位のレビュー)
git diff --name-only origin/main...HEAD
# 未コミットの変更
git diff --name-only HEAD
# 未追跡ファイル
git ls-files --others --exclude-standard
```

PR 用か未コミットかは状況で判断する。迷ったら両方確認する。
変更ファイルが空なら「レビュー対象の差分なし」と報告して終了。

### 2. レビューエージェントの選定と並列起動

**該当する全エージェントを 1 メッセージ内で並列に起動する** (Agent tool を 1 メッセージに複数並べる)。
akashic 専用のエージェント定義ファイルは無いので、`Explore` または `general-purpose` エージェントに下表の観点をプロンプトとして渡す。

| 起動条件 | 観点名 | 見るもの |
|---|---|---|
| `src/**/*.ts(x)` に変更 | **clearance-rls** | 後述の最重要チェックリスト |
| `src/**/*.ts(x)` に変更 | **bug-hunter** | ロジック誤り・null 安全性・境界値・**JST/UTC のズレ** |
| `src/**/*.ts(x)` に変更 | **code-quality** | TS 規約 (`strict`)・kebab-case ファイル名・`@/` エイリアス・重複・マジックナンバー |
| `src/lib/domain/**`, `src/lib/search/**`, `src/app/api/**` | **performance** | N+1・不要な全件取得・`unstable_cache` の revalidate/タグ設計・トランザクション時間 |
| `src/app/**` | **architecture** | Server/Client 境界・Server Actions の置き場所 (汎用=`src/lib/actions.ts` / ページ固有=コロケーション)・`loading.tsx` の有無 |
| `src/app/api/v1/**` | **api-contract** | `requireApiAuth` の返り値が `NextResponse` かの分岐・zod 検証・`docs/api.md` の更新漏れ |
| `prisma/schema.prisma`, `prisma/migrations/**` | **db-migration** | 後述の DB チェックリスト |
| `src/components/**`, `src/app/**/*.tsx` | **ui-consistency** | 日本語 UI 文言・ラベルは `src/lib/utils.ts` の `*_LABELS` に集約されているか・`cn()` 利用・shadcn 部品の踏襲 |

`.md` / 設定ファイル (`.json` / `.yml`) のみの変更はレビュー対象外として終了。

### 3. clearance / RLS チェックリスト (akashic 最重要)

**RLS 違反はエラーにならず「無言で 0 行」になる。** テストが無い akashic では本番まで気づけないので、ここを最優先で見る。

- [ ] 保護テーブル (`Asset`, `AssetText`, `AssetEntity`, `AssetRelation`, `SourceRecord`, `Annotation`, `Testimonial`, `Dossier`, `Place`, `RepoCollection`, `Lens`, `DataSource`, `Coverage`, `LensItemCheck`) を **素の `prisma` で読み書きしていないか** → `withClearance` / `withSession` を使う
- [ ] `Dossier` 系に触るなら **`withSession`** か (= `app.user_id` が要る。`withClearance` では権限判定できない)
- [ ] `prismaInternal` を使っているなら、それが CLI / Bot / 全体統計であることが妥当か (= ユーザー向けレスポンスに使っていないか)
- [ ] **書き込み時に `assertClearance` を通しているか** (= RLS は読みを守るが、自分より上のクリアランスを付けて作る操作はアプリ層で止める)
- [ ] 生 SQL (`$queryRaw`) を使うなら `classificationFilterSql` を通しているか
- [ ] トランザクションが重い場合、既定 15,000ms を超えないか (= 超えると P2028)

判断に迷ったら `docs/security-dev.md` を正とする (`docs/architecture.md` は陳腐化しているので参照しない)。

### 4. DB マイグレーションチェックリスト

- [ ] 新規テーブルに `classification ClearanceLevel` が要るか判断されているか
- [ ] 要るなら **RLS ポリシー + `ENABLE` + `FORCE ROW LEVEL SECURITY`** が migration に含まれているか
- [ ] **本番 Supabase で手動実行する `GRANT SELECT, INSERT, UPDATE, DELETE ON "<Table>" TO app_runtime;` が migration 冒頭のコメントに明記されているか** (= 漏れると本番で権限エラー)
- [ ] 破壊的変更 (カラム削除・NOT NULL 追加) に既存データの移行が伴っているか
- [ ] 適用済み migration を書き換えていないか

詳細は `/db-migration` スキル参照。

### 5. レビュー結果の集約

エージェントごとの視点を残したままセクション別に出力する:

```
## Clearance / RLS Review
[Critical] ...

## Bug Hunter
[Warning] ...

## Performance Review
...
```

### 6. サマリー

```
## Summary
| レベル | 件数 |
|--------|------|
| Critical | 2 |
| Warning | 5 |
| Suggestion | 3 |
| **合計** | **10** |
```

Critical があれば **ユーザーに修正方針を確認** してから対応に入る。Warning / Suggestion は判断材料として提示する。

## 注意事項

- 変更のないファイル・削除されたファイルはレビュー対象外
- レビュー結果に基づく自動修正はしない。ユーザー判断を待つ
- エージェントの指摘が重複した場合は、出力時に重複排除メモを添える
- 対応しない Warning / Suggestion は `/issue` で別 Issue に切り出す (= 黙って捨てない)
