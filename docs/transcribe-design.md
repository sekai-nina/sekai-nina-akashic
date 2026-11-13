# 音声・動画の文字起こし (#282)

音声・動画のアセットは中身がテキストになっていないので検索に引っかからない。OpenAI の gpt-transcribe で文字起こしし、`AssetText(textType = transcript)` に置いて PGroonga 検索に載せる。

## 何を回すか

| 経路 | 対象 | 入口 |
|---|---|---|
| 自動 (15 分ごと) | 坂井新奈のトーク (下記) で、まだのもの | `GET /api/cron/transcribe` (`vercel.json`、`CRON_SECRET` 必須) |
| 手動 | ほかの音声・動画を 1 件ずつ。やり直しもここ | アセット詳細の「文字起こし」パネル (admin / member) |

- **坂井新奈のトーク** = `kind` が `audio` / `video`、坂井新奈 (`NINA_ENTITY_ID`) とタグ `トーク` の両方が紐づいている、`storageProvider = gdrive`。タイトル (`坂井新奈トーク …`) でも同じ集合になる (2026-10-27 時点で音声 40 件 + 動画 167 件) が、紐づきのほうが壊れにくい
- **外部 (OpenAI, 米国) に送るのは `public` / `internal` だけ。** `confidential` / `restricted` は自動でも手動でも送らない (ユーザー判断)。cron は RLS をバイパスする `prismaInternal` なので、`classification` を明示して絞っている
- 25 MB を超えるもの (OpenAI のアップロード上限) は送らずに「できなかった」にする

## 流れ

1. `src/lib/drive/index.ts` の `downloadFromDrive` で本体を取る (メモリに載せる)
2. **音声トラックが無ければ送らない** (`src/lib/transcribe/mp4.ts`)。MP4 のボックス (`moov > trak > mdia > hdlr`) を辿って `soun` のトラックを探すだけで、デコードはしない。トーク動画の 2/3 (167 件中 109 件) は画面だけで音声トラックが無い。2026-10-27 に全 207 件を ffprobe と突き合わせて判定が全件一致、音声トラックがあって無音のもの (最大音量 −40 dB 未満) は 0 件だったので、音量までは見ない (見るには ffmpeg が要る)
3. OpenAI `POST /v1/audio/transcriptions` に mp4 / m4a のまま送る (`src/lib/transcribe/openai.ts`)。`model = gpt-transcribe`、`language = ja`、`response_format = json`、`prompt` に録音の説明、`keywords[]` に「五期生」「ひなあい」などの聞き違えやすい言葉
   - **`verbose_json` は使えない** (400)。区間・タイムスタンプ・確信度は返らない
   - **keywords にメンバーの名前を入れない。** 現役 27 人を入れたら、一人称「ニーナ」が「りな」になり、「またかけるね」が「また食べるね」になった (2026-11-14 の試し)。prompt が無いと「ニーナは」が「今は」になった
4. 文ごとに改行し、まるごと「ご視聴ありがとうございました」等の決まり文句の文を捨てる (文の中なら残す。`src/lib/transcribe/hallucination.ts`)。gpt-transcribe は全体を 1 行で返す
5. 本文があれば `addTextRevision` (`src/lib/domain/text-revisions.ts`) で `AssetText(transcript)` を作る。やり直しで本文が変わったら旧本文を版に残し、抜粋 (クリップ・記事の出典) の範囲を探し直す。**喋っていなかったときは既存の本文を消さない**
   - cron は transcript が既にあるアセットを拾わない (人が入れた本文を上書きしない)
   - 書き込みは `withClearance` (cron は対象の上限の `internal`)。読んでから送るまでに機密へ上げられたアセットは、送る直前の再確認で止まり、書き込みも RLS で止まる
6. `Asset.transcribedAt` を立てる (生 SQL。`@updatedAt` を動かさない)

## 「済み」の印

`AssetText` の有無では判定できない (喋っていない動画は本文が空で行が増えないので、毎回送り直して課金される)。そこで `Asset.transcribedAt` / `transcribeError` を持つ。

| 結果 | `transcribedAt` | `transcribeError` | cron |
|---|---|---|---|
| 保存した / 喋っていなかった / 音声トラックが無い (`mp4.ts` が送る前に判定) | 立てる | null | 拾わない |
| 送り直しても直らない (25 MB 超・Drive の 404・OpenAI の 413 / 415・`error.param = "file"` の 400) | 立てる | 理由 | 拾わない |
| 一時的 (Drive の失敗・OpenAI の 5xx・通信・想定外の例外) | 立てない | — | 次の回に拾い直す |
| ほかのファイルでも同じになる (OpenAI の 429 / 401・prompt や keywords、モデルが原因の 400) | 立てない | — | その回を打ち切る |

**400 をまとめて「ファイルのせい」にしない。** OpenAI は 400 の `error.param` で原因の引数を返すので、`file` のときだけファイルのせいにする。prompt が長すぎる・モデルが廃止された 400 で失敗にすると、cron が 15 件ずつ全件を対象から外してしまう (`isFileProblem`)。

1 回の cron は新しい順に最大 15 件。新しい 1 件を始めるのは 150 秒まで (1 件は最悪 Drive 30 秒 + OpenAI 90 秒で、`maxDuration = 300` に収まる)。`/status` の `cron.transcribe` に件数を残し、打ち切った回と、1 件も進まず全部が一時的な失敗だった回は異常にする。

## 費用

gpt-transcribe は $0.0045 / 音声 1 分 (https://developers.openai.com/api/docs/models/gpt-transcribe, 2026-11-14)。応答の `usage.seconds` が課金秒数。トークは 1 件 20 秒〜1 分半ほどで、1 件 0.2〜1 円。

利用量は `/costs` に `provider = openai` / `model = gpt-transcribe` / `feature = akashic.transcribe` で自己申告する。**`inputTokens` に課金秒数を入れる** (`docs/costs-design.md`)。OpenAI の確定額 (`/v1/organization/costs`) にも含まれる。

## Groq からの切り替え (2026-11-14)

最初は Groq の whisper-large-v3 (無料枠) で回していたが、聞き違いが多く、句読点も付かなかった。同じトークを送り比べて gpt-transcribe に替えた。

それまでに文字起こししたトーク (623 件。本文あり 279 件) は `pnpm cli:retranscribe-talks` でやり直す (既定は下見)。旧本文は版に残り、抜粋の範囲は探し直す。文字起こしのあとに人が本文を直したものは飛ばす。`/costs` の Groq の行は過去の分として残る (単価表も残す)。

## 環境変数

- `OPENAI_API_KEY` — 未設定なら cron は何もしない (200 で `skipped`)。ボタンはエラーを出す。今日の発見のアイコン・ミーグリのスケッチと同じキー

## OpenAI のデータの扱い

API の入出力は学習には使われない。不正利用の監視のため最大 30 日保持される (Zero Data Retention は組織単位の申請制)。https://platform.openai.com/docs/guides/your-data
