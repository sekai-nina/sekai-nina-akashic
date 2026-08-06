---
name: grill-me
description: 設計案の各分岐を 1 問ずつ追及してユーザーと合意形成する対話型スキル。プランや設計を詰めたいとき、「grill me」「詰めて」「設計を固めたい」と言われたとき、および 3 ステップ以上の実装に入る前に使う。
---

# /grill-me — 設計を 1 問ずつ詰める

設計判断の各分岐をユーザーに 1 問ずつ問い、合意できるまで潰していく。本プロジェクトでは **3 ステップ以上のタスクを実装する前に起動する**。

## いつ発動するか

- 実装に入る前 (= 設計判断が見えた瞬間)
- ユーザーが「grill me」「詰めて」「設計を固めたい」と言ったとき
- Issue から作業を始めるとき (= Issue 本文だけでは決まらない分岐が必ず残る)

逆に、1 ファイル・数行で終わる自明な修正では呼ばない。

## 原則

- **1 度に 1 問だけ聞く。** 複数並べない (= ユーザーが 1 問ずつ考えられる形にする)
- **コードを読めば分かることはユーザーに聞かない。** 先にコードベースを調べる
- **各質問には推奨案を添える。** ユーザーが Yes / No / 別案 で答えられる形にする
- **分岐の依存関係を上から解く。** 先に決まらないと後段が決められない問いを優先する

## 手順

### 1. コードベースを先に調べる

質問リストを作る前に、以下を確認して「聞かなくてよいこと」を削る:

- 対象の既存実装 (= 似た機能がすでにあるなら踏襲するのが既定)
- `prisma/schema.prisma` (= データモデル上その設計が可能か)
- `src/app/api/**` の既存 route (= API の形の前例)
- `src/components/**` の既存コンポーネント (= UI の前例)

### 2. 分岐を洗い出して 1 問ずつ聞く

`AskUserQuestion` を使い、選択肢に推奨案を先頭 (= `(推奨)` 付き) で並べる。

akashic で頻出する分岐:

| 分岐 | 典型的な問い |
|---|---|
| データモデル | 既存モデルにカラム追加か、新モデルか。enum に値を足すか自由文字列か |
| 取得方式 | Server Component で直接 Prisma か、`/api/**` 経由か |
| 検索・絞り込み | 既存の検索クエリに乗せるか、別エンドポイントか |
| 権限 | 認証必須か、公開してよいか |
| 表示 | 既存の一覧 / 詳細に足すか、新規ページか |
| 移行 | 既存データのバックフィルが要るか |

### 3. 合意内容を残す

合意できた内容は、実装に入る前に **箇条書きのサマリーとしてユーザーに提示する**。Issue から始めた作業なら、合意内容を Issue にコメントで残す:

```bash
gh issue comment <number> --body "<合意した設計方針>"
```

## Prompt (agent-facing)

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.

## 注意事項

- 質問が 1 問も出てこない場合は、そもそも設計判断がない (= このスキルは不要)。素直に実装に入る
- ユーザーが「もういいから作って」と言ったら止める (= 詰め切ることが目的ではなく、認識ズレを潰すのが目的)
- UI のレイアウト / 動線が争点になったら、言葉で詰めるより **単一 HTML のモックを `docs/mockups/` に書いてブラウザで触ってもらう** 方が速い (= akashic は Next.js + Tailwind なので、モックの構造をそのまま実装に持ち込める)
