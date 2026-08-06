---
name: db-migration
description: Prisma のスキーマ変更とマイグレーション追加を行うワークフロー。shadow DB 障害の回避、RLS ポリシーの追記、本番の手動 GRANT までをカバーする。テーブル追加・カラム追加・enum 変更のときに必ず使う。
---

# DB Migration

akashic のマイグレーションは **`pnpm db:migrate` (= `prisma migrate dev`) が必ず失敗する**ため、専用手順が要る。

## 前提: なぜ `migrate dev` が使えないか

`prisma migrate dev` は shadow DB に既存マイグレーションを再適用するが、`20260504_simplify_categories` がデータ依存のマイグレーションで、空の shadow DB では

```
invalid input value for enum "TestimonialCategory": "performance"
```

となって **必ず落ちる**。過去の migration を書き換えて直すのは本番履歴と食い違うので採らない。代わりに **live DB との差分から SQL を生成して `migrate deploy` で当てる**。

## 手順

### 1. `prisma/schema.prisma` を編集

保護対象のテーブルなら `classification ClearanceLevel` を持たせるか判断する。持たせるなら RLS が要る (ステップ 4)。

### 2. live DB との差分から SQL を生成

```bash
npx prisma migrate diff \
  --from-url "$DIRECT_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

**この出力をそのまま使わない。** schema 管理外の trgm インデックスを `DROP` しようとするので、**CREATE / ALTER の追加分だけを手で残し、`DROP INDEX` 行は捨てる**。

### 3. migration ファイルを手書きで作成

```
prisma/migrations/<YYYYMMDDHHMMSS>_<snake_case>/migration.sql
```

冒頭に「何を・なぜ変えるか」のコメントブロックを書く (= 既存 migration の慣習)。

### 4. RLS ポリシーを追記 (保護テーブルの場合)

`clearance_rank()` は `20260511000000_add_rls` で定義済み。4 操作ぶんのポリシーを同形で書く:

```sql
ALTER TABLE "<Table>" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "<Table>" FORCE ROW LEVEL SECURITY;

CREATE POLICY <table>_select ON "<Table>" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY <table>_insert ON "<Table>" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY <table>_update ON "<Table>" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY <table>_delete ON "<Table>" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
```

- `clearance_rank()` は未知 / 未設定を `-1` にして **fail-closed** にする設計。`app.clearance` が立っていなければ 0 行になるのが正しい挙動
- 子テーブル (= 自前の `classification` を持たず親 Asset に従うもの) は、親の存在チェックで判定する。`20260511000000_add_rls` の `AssetText` 等の書き方を踏襲する

### 5. 手動 GRANT の注意書きを migration 冒頭に入れる

**Prisma は新テーブルへの `app_runtime` 権限を自動で付けない。** これを忘れると本番で権限エラーになる。必ず migration の冒頭コメントに書き残す:

```sql
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "<Table>" TO app_runtime;
```

### 6. 適用

```bash
npx prisma migrate deploy   # shadow DB を使わないので過去 migration を再生しない
npx prisma generate
pnpm typecheck
```

### 7. 本番 (Supabase) への適用

1. Supabase SQL Editor で migration SQL を実行する
2. **ステップ 5 の `GRANT` を実行する**
3. 実データで動作確認する (= akashic にはテストが無い。`npx tsx -e '...'` で実 DB を叩いて確認するのが慣習)

適用したかどうかをユーザーに必ず報告する。

## アプリ側の書き分け

migration を入れたら、アプリからのアクセス方法も揃える:

| 状況 | 使うもの |
|---|---|
| ユーザーへのデータ返却 / CRUD | `withClearance(clearance, tx => …)` |
| Dossier 系 (= 所有者判定が要る) | `withSession({ id, clearance }, tx => …)` |
| CLI・Bot・全体統計 | `prismaInternal` (`DIRECT_URL` / `postgres` ロール、RLS バイパス) |
| `User` / `Entity` など非保護テーブル | 素の `prisma` |

書き込み時のクリアランス超過は RLS では止まらない箇所があるので、`src/lib/classification.ts` の `assertClearance` を通す。

## 注意事項

- **適用済み migration を編集しない。** 直したいことがあれば新しい migration を足す
- `pnpm db:push` は開発 DB の実験用。本番には使わない (= 履歴が残らない)
- enum への値追加はデータ依存のマイグレーションを生みやすい (= `20260504_simplify_categories` の再来)。値を消す変更は特に慎重に
- 変更後は `docs/security-dev.md` の保護テーブル一覧と、必要なら `docs/api.md` を同じ PR で更新する
- コミットは `:ballet_shoes:`、それを使う実装は別コミット (`:dog2:`)
