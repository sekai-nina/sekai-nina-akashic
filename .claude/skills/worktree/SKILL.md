---
name: worktree
description: git worktree の作成・一覧・切替・削除を管理するスキル。実装タスクを始める前に必ず worktree を作る。「ブランチ切って」「worktree 作って」「Issue #N やる」のときに使う。
---

# Worktree 管理

akashic の実装作業は **すべて worktree で行う**。メインのワーキングツリー (`main`) を汚さない。

## コマンド

### 作成: `/worktree create <name>` / `/worktree create #<issue番号>`

#### ブランチ命名規約

ケバブケース。日本語は使わない。

| プレフィックス | 用途 | 例 |
|---|---|---|
| `feature/` | 新機能 | `feature/entity-generation` |
| `fix/` | バグ修正 | `fix/gallery-date` |
| `chore/` | 設定・ドキュメント・リファクタ | `chore/add-claude-skills` |

#### 手順

**1. Issue 番号が指定された場合は先に内容を取得する**

```bash
gh issue view <number> --json title,body,labels
```

ブランチ名は Issue の内容から英語で付ける (= Issue タイトルの直訳ではなく、変更内容を端的に表す名前)。

**2. 最新の main を取得して worktree を作成**

ブランチ名の `/` を `-` に置換したものを worktree ディレクトリ名にする。

```bash
git fetch origin main
BRANCH="<prefix>/<branch-name>"
WORKTREE_DIR=$(echo "$BRANCH" | tr '/' '-')
git worktree add ".claude/worktrees/$WORKTREE_DIR" -b "$BRANCH" origin/main
```

- 必ず **`origin/main`** から分岐する (= akashic のデフォルトブランチは `main`)
- worktree は `.claude/worktrees/` 配下 (`.gitignore` で除外済み)

**3. `.worktreeinclude` のファイルをコピー**

`.env` は git 管理外なので worktree に付いてこない。コピーしないと `prisma` も `next dev` も動かない。

```bash
while IFS= read -r file; do
  [ -f "$file" ] && cp "$file" ".claude/worktrees/$WORKTREE_DIR/$file"
done < .worktreeinclude
```

**4. worktree に移動して環境セットアップ**

```bash
cd ".claude/worktrees/$WORKTREE_DIR"
pnpm install          # node_modules は worktree に付いてこない
pnpm prisma generate  # Prisma Client も worktree ごとに必要
```

ドキュメント / スキルのみの変更なら本ステップはスキップ可。

**5. 設計を詰める**

3 ステップ以上のタスクなら、実装前に `/grill-me` を起動する。

### 一覧: `/worktree list`

```bash
git worktree list
```

各 worktree のパス・ブランチ名・最新コミットの要約を表示する。

### 切替: `/worktree switch <name>`

1. 現在の worktree に未コミットの変更がないか確認する (`git status`)
   - 変更があればユーザーに警告し、コミットまたはスタッシュを提案する
2. 指定した worktree のパスに移動する

### 削除: `/worktree remove <name>`

1. 対象 worktree に未コミットの変更がないか確認する。あればユーザーに確認を取る
2. ブランチが `main` にマージ済みか確認する

   ```bash
   git merge-base --is-ancestor <branch-name> origin/main && echo MERGED || echo unmerged
   ```

   `git branch --merged` は squash merge を検出できないので、判定に迷ったら `gh pr list --state merged --head <branch-name>` も併用する (= akashic は squash merge 運用)。
3. **gitignore されたファイルの退避を確認する** — `git worktree remove` は `.env` や生成物も一緒に消す。残したいものがないかユーザーに確認する
4. 削除する

   ```bash
   git worktree remove .claude/worktrees/<name>
   git branch -d <branch-name>   # マージ済みの場合
   ```

### 掃除: `/worktree prune`

1. 全 worktree のブランチについてマージ済み判定を出す

   ```bash
   git fetch origin main
   for b in $(git worktree list --porcelain | grep '^branch' | sed 's|branch refs/heads/||'); do
     git merge-base --is-ancestor "$b" origin/main 2>/dev/null \
       && echo "MERGED  $b" || echo "unmerged $b"
   done
   ```
2. マージ済みの worktree を一覧表示し、**ユーザーに一括削除の確認を取る**
3. 承認されたものだけ削除する
4. `git worktree prune` で参照切れを掃除する

## 注意事項

- **削除は必ずユーザーの確認を取ってから実行する**
- 未マージのブランチを `git branch -D` (強制削除) する場合は明示的に警告する
- マージ済み判定の基準は **`origin/main`**
- worktree の削除は **対象 worktree の外** から実行する (= 自分が居るディレクトリは消せない)
- 作業完了後は `/worktree remove` で片付ける (= 放置すると `.claude/worktrees/` が肥大化し、どれが生きているか分からなくなる)
