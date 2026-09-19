# X 言及監視 (`/mentions`) 設計書

> 2026-09 策定 (#142)。X で坂井新奈への言及を毎日拾い、公式アカウント等の「分かっている投稿者」を除いたものだけを Discord に流す。監視語と除外ユーザーは akashic の画面で変える。

## 1. 流れ

```
09:00 JST  Vercel Cron → GET /api/cron/mentions (CRON_SECRET)
             └ runMentionWatch()  src/lib/x-mentions/run.ts
                 ├ 有効な監視語ごとに X recent search（-is:retweet と除外ユーザーの -from: を付けて）
                 │   → 除外ユーザー以外を XMentionHit に保存、lastTweetId を進める
                 ├ 未通知のヒットを Discord へ 1 件 1 メッセージ（送れたものだけ notifiedAt）
                 └ Job `cron.x_mentions` にハートビート（/status に出る）
```

`/mentions` の「今すぐ実行」も同じ関数を呼ぶ（cron と結果が同じであることを保証する）。

## 2. データモデル（3 つとも保護テーブル、既定 `internal`）

| テーブル | 役割 | 要点 |
|---|---|---|
| `XMentionWatch` | 監視語 | X の検索クエリを**そのまま**持つ（`"坂井新奈"` / `にいなちゃん OR にーなちゃん`）。`lastTweetId` が次回の `since_id`。`lastError` に直近の X API 失敗を残す |
| `XMentionSetting` | 除外ユーザー | 全監視語で共通なので singleton（`id = "singleton"`）。ユーザー名は @ 抜き小文字の配列 |
| `XMentionHit` | 拾ったツイート | 監視語ごとに 1 行（`@@unique([watchId, tweetId])`）。`notifiedAt` が null なら未送信 |

cron はセッション外で走るので `prismaInternal`（RLS バイパス）で読み書きし、画面は `withClearance` で読む。同じツイートが複数の監視語に当たると行は複数になるが、Discord には `tweetId` ごとに 1 回しか送らない（`notifyPending` がまとめる）。

## 3. クエリと重複防止（`src/lib/x-mentions/query.ts`）

- 実行時のクエリ = `<監視語> -is:retweet -from:a -from:b …`。`-from:` はクエリ側で除外したほうが X の読み取り枠を食わないので優先して入れるが、**上限 512 文字（Basic プラン）に入りきらない分はアプリ側で落とす**（`isExcluded`）。結果は同じ
- 初回（`lastTweetId` なし）は直近 24 時間。以降は `since_id`。X API は `since_id` と `start_time` を同時に渡すと `since_id` を優先するので、`since_id` があるときは時間窓を渡さない
- 前回の確認から 6 日以上空いていたら `since_id` は古すぎて拒まれうるので捨て、直近 7 日（recent search の上限）を取り直す
- `since_id` は除外ユーザーの投稿も含めた「見た中で最新」まで進める（除外分をもう一度読まないため）。ツイート ID は Number では丸まるので BigInt で比べる
- 1 監視語 1 回あたり最大 2 ページ（200 件）。監視語が数語なら 1 日あたり数百件で、Basic プランの月 1 万件に収まる

## 4. 通知

- `DISCORD_MENTION_WEBHOOK_URL`（`/status` の障害通知 `DISCORD_STATUS_WEBHOOK_URL` とは**別チャンネル**）。未設定なら保存だけ行い、`notifiedAt` は立てない（設定した後の初回に溜まっていた分が流れる）
- 1 ヒット 1 メッセージ。監視語・投稿者・時刻・本文（280 文字まで）・ツイート URL。URL は裸で置いて Discord にツイートを展開させる。`allowed_mentions` は空
- webhook は 1 本あたり 2 秒に 5 件なので 0.5 秒ずつ空け、429 は `retry_after` だけ待って 1 回やり直す（`postDiscordWebhook`）
- 送信に失敗したらそこで打ち切り、残りは次回に再送（`notifiedAt` が進まない）

## 5. 画面 `/mentions`

- member 以上が編集、viewer は閲覧のみ。サイドバーは「レポ収集」の下
- 上から「今すぐ実行」と最終実行（`Job.lastMessage`）、監視語の一覧（追加・編集・有効/無効・削除）、除外ユーザー（textarea、改行かカンマ区切り、形が違えば保存せず指摘）、直近のヒット 100 件

## 6. `/status` との関係

`recordJobRun("cron.x_mentions", { intervalSec: 86400 })` を毎回残す。X API か Discord に失敗した回は `error` で残るので、/status の「ジョブ」で赤くなる。cron が呼ばれなくなれば「報告が途絶えた」で気づける。

## 7. 環境変数

| 変数 | 用途 |
|---|---|
| `X_BEARER_TOKEN` | X API v2（`/repo` と共用。search は Basic 以上） |
| `DISCORD_MENTION_WEBHOOK_URL` | 通知先。未設定なら通知しない |
| `CRON_SECRET` | `/api/cron/*` 共通 |

## 8. 既知の限界・今後

- recent search は直近 7 日しか遡れない。1 週間以上止まっていた分は拾えない（/status で気づく前提）
- X 側の検索は完全一致ではない（`"坂井新奈"` でも表記揺れは拾わない）。揺れは監視語を `OR` で足して吸収する
- 引用ツイートは拾う（`-is:retweet` はリツイートだけ除く）。引用元が除外ユーザーでも引用した人が対象なら流す
