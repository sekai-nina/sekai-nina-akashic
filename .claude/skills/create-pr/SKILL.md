---
name: create-pr
description: Pull Request を作成するワークフロー。typecheck・/review の実施、main への PR 作成までを行う。「PR を作って」と言われたときに使う。
---

# Create PR

## 手順

### 1. 未コミットの変更を確認

```bash
git status
```

未コミットの変更があれば、先に `/commit` でコミットする。
**ユーザーが動作確認 (= `pnpm dev` で画面を見ている) の最中なら PR を作らない。** 明示的な「PR 作って」を待つ。

### 2. 型チェック

```bash
pnpm db:generate && pnpm typecheck
```

CI (`.github/workflows/deploy.yml` の `check` ジョブ) が回すのと同じ内容。ここで落ちるものは push しない。

### 3. コードレビューの実施

`/review` スキルを実行する。

- **Critical** は必ず修正してから PR を作成する
- **Warning** は原則修正する
- **Suggestion** は任意。簡単なものは直し、残すなら `/issue` で別 Issue に切り出す

### 4. リモートへのプッシュ

```bash
git push -u origin $(git branch --show-current)
```

### 5. PR の作成

PR タイトル: 日本語・70 文字以内・変更内容を端的に。

```bash
gh pr create --base main --title "<PRタイトル>" --body "$(cat <<'EOF'
## 概要
(変更の目的を 1-3 行)

## 変更内容
- 変更点1
- 変更点2

## 影響範囲
- RLS / クリアランス: (保護テーブルに触るか。触るなら withClearance/withSession 経由か)
- マイグレーション: (あるか。あるなら本番での手動 GRANT が要るか)
- ドキュメント: (docs/api.md / 設計書の更新有無)

## 動作確認
- [ ] `pnpm typecheck`
- [ ] 確認手順1
- [ ] 確認手順2

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**「影響範囲」は akashic 固有で必須。** RLS を経由しない DB アクセスと、GRANT 漏れのマイグレーションが本番で無言の障害になるため、レビュアーが真っ先に見る欄。

### 6. Issue との紐付け

Issue から始めた作業なら、PR 本文に `Closes #<number>` を入れる。Project 上の Status も `In progress` に更新する (`/issue` スキルの ID 表を参照)。

### 7. PR URL の共有

作成した PR の URL をユーザーに共有する。

## 注意事項

- PR のベースは **`main`** (= akashic のデフォルトブランチ)
- `main` から直接 PR を作成しない (= 必ず `/worktree create` したブランチから)
- PR 作成前に必ず `/review` を実施する。Critical が残っている状態で PR を作成しない
- マージ後は `/worktree remove` で worktree を片付ける
- akashic は **squash merge** 運用。マージ済み判定に `git branch --merged` は使えない (= `git merge-base --is-ancestor` か `gh pr list --state merged --head <branch>`)
