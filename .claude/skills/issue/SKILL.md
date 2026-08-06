---
name: issue
description: GitHub Issue を起票し、Project (sekai-nina/projects/1) に規約どおりのフィールド (Area=Dev / Importance / Size / Urgency / Status) で登録するスキル。「Issue 化して」「別 Issue にして」「起票して」のときに使う。
---

# Issue 起票

レビュー指摘の別 Issue 化や、新機能・バグの起票を、GitHub Projects の運用規約に沿って 1 回で済ます。

## 手順

### 1. 内容の整理

- **タイトル**: 日本語で簡潔に。何を直す / 足すかが一読で分かる形
- **本文の構成**:

  ```markdown
  ## 背景
  (なぜこの Issue が必要か。レビュー由来なら「#NNN PR のレビューで発見された Warning」等の出自)

  ## 対象 (or 受け入れ条件)
  (具体的な変更点・完了条件。file:line / コード片を含める)

  ## 関連
  (関連 PR / Issue へのリンク)
  ```

- **レビュー由来の場合**は指摘の原文と `file:line` をそのまま引用する (= 後で読む人がコンテキストを再構築できる)
- **固有名詞は実装と照合してから書く** — Prisma のモデル名 / enum 値 / API route のパス / 環境変数名は grep で実在を確認する (= 古い記憶ベースで書かない)

### 2. 起票

```bash
gh issue create --title "<タイトル>" --body "<本文>"
```

- ラベルは任意。付けるなら既存ラベル (`bug` / `enhancement` / `documentation` 等) のみ。**新規ラベルを勝手に作らない**

### 3. Project への登録とフィールド設定

Project ID とフィールド ID は安定しているので、以下をそのまま使う。

```
PROJECT_ID = PVT_kwDOD2XXys4BN5sc
```

| フィールド | Field ID | Option ID |
|---|---|---|
| `Area` | `PVTSSF_lADOD2XXys4BN5sczg8wyvE` | **Dev=`ba9a7f84`** (akashic は Dev 固定) |
| `Status` | `PVTSSF_lADOD2XXys4BN5sczg8wxlc` | Todo=`f75ad846` / In progress=`47fc9ee4` / Done=`98236657` |
| `Importance` | `PVTSSF_lADOD2XXys4BN5sczg8wx68` | Critical=`74c0a9ce` / High=`d83acd14` / Medium=`5b4a4741` / Low=`cf3a7820` |
| `Size` | `PVTSSF_lADOD2XXys4BN5sczg8wx7A` | XS=`8fefced2` / S=`98b08c30` / M=`5cf1263a` / L=`5690bf4e` / XL=`6b7b1592` |
| `Urgency` | `PVTSSF_lADOD2XXys4BN5sczg_8tr4` | Urgent=`b450659a` / Soon=`67fa727c` / Later=`f9b75ad0` / Anytime=`0021ad48` |

`Page` フィールドは meet-greet-app の画面名 (ホーム / 計画 / 記録 / マイページ) 専用なので **akashic では設定しない**。

```bash
# Issue を Project に追加 (ITEM_ID が返る)
ITEM_ID=$(gh project item-add 1 --owner sekai-nina --url <issue_url> --format json --jq .id)

# フィールド設定 (single-select フィールドごとに 1 回)
gh project item-edit --project-id PVT_kwDOD2XXys4BN5sc --id "$ITEM_ID" \
  --field-id <FIELD_ID> --single-select-option-id <OPTION_ID>
```

ID が上表と食い違ったら (= フィールドを作り直した等) 以下で取り直し、本ファイルを更新する:

```bash
gh project field-list 1 --owner sekai-nina --format json
```

### 4. 値の決め方

| フィールド | 決め方 |
|---|---|
| `Area` | **Dev 固定** (= 本リポジトリの Issue はすべて Dev) |
| `Importance` | `Critical` / `High` / `Medium` / `Low` — **ユーザーに確認** (推奨を添えて 1 問) |
| `Size` | `XS` / `S` / `M` / `L` / `XL` — 変更規模から推定して提示 |
| `Urgency` | `Urgent` / `Soon` / `Later` / `Anytime` — **ユーザーに確認** (Importance と同時に聞いてよい) |
| `Status` | `Todo` |

### 5. 報告

Issue URL と設定したフィールド値の一覧をユーザーに提示する。

## 注意事項

- Importance / Urgency はユーザーの優先順位観なので勝手に確定しない (= 推奨案を添えて確認する)
- 複数 Issue をまとめて起票する場合、フィールド確認は 1 回のやり取りに束ねる (= Issue ごとに往復しない)
- レビュー指摘の別 Issue 化では「本 PR でやらない理由」(= スコープ外 / 横断的 / 設計判断が要る) を背景に 1 行残す
- Issue から実装を始めるときは `/worktree create` → `/grill-me` の順に進む
