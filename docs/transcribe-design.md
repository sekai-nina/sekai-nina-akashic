# 音声・動画の文字起こし (#282)

音声・動画のアセットは中身がテキストになっていないので検索に引っかからない。Groq の Whisper で文字起こしし、`AssetText(textType = transcript)` に置いて PGroonga 検索に載せる。

## 何を回すか

| 経路 | 対象 | 入口 |
|---|---|---|
| 自動 (15 分ごと) | 坂井新奈のトーク (下記) で、まだのもの | `GET /api/cron/transcribe` (`vercel.json`、`CRON_SECRET` 必須) |
| 手動 | ほかの音声・動画を 1 件ずつ。やり直しもここ | アセット詳細の「文字起こし」パネル (admin / member) |

- **坂井新奈のトーク** = `kind` が `audio` / `video`、坂井新奈 (`NINA_ENTITY_ID`) とタグ `トーク` の両方が紐づいている、`storageProvider = gdrive`。タイトル (`坂井新奈トーク …`) でも同じ集合になる (2026-10-27 時点で音声 40 件 + 動画 167 件) が、紐づきのほうが壊れにくい
- **外部 (Groq, 米国) に送るのは `public` / `internal` だけ。** `confidential` / `restricted` は自動でも手動でも送らない (ユーザー判断)。cron は RLS をバイパスする `prismaInternal` なので、`classification` を明示して絞っている
- 25 MB を超えるもの (Groq のアップロード上限) は送らずに「できなかった」にする

## 流れ

1. `src/lib/drive/index.ts` の `downloadFromDrive` で本体を取る (メモリに載せる)
2. **音声トラックが無ければ送らない** (`src/lib/transcribe/mp4.ts`)。MP4 のボックス (`moov > trak > mdia > hdlr`) を辿って `soun` のトラックを探すだけで、デコードはしない。トーク動画の 2/3 (167 件中 109 件) は画面だけで音声トラックが無い。2026-10-27 に全 207 件を ffprobe と突き合わせて判定が全件一致、音声トラックがあって無音のもの (最大音量 −40 dB 未満) は 0 件だったので、音量までは見ない (見るには ffmpeg が要る)
3. Groq `POST /openai/v1/audio/transcriptions` に mp4 / m4a のまま送る (`src/lib/transcribe/groq.ts`)。`model = whisper-large-v3`、`language = ja`、`response_format = verbose_json`、`prompt` に現役メンバーの名前と「五期生」などの聞き違えやすい言葉 (固有名詞の誤変換を減らす。224 トークン上限。入れる前は「五期生楽曲」が「ご規制楽曲」になった)
4. 区間ごとに「喋っていないのに出てきた文」を捨てる (`src/lib/transcribe/segments.ts`)
   - Whisper 本体と同じ判定: `no_speech_prob > 0.6` かつ `avg_logprob < -1`、`compression_ratio > 2.4`
   - 区間がまるごと「ご視聴ありがとうございました」等の決まり文句なら捨てる (文の中なら残す)
5. 本文があれば `AssetText(transcript)` を作る / 置き換える。空なら作らない (やり直しで空になったら消す)
6. `Asset.transcribedAt` を立てる (生 SQL。`@updatedAt` を動かさない)

## 「済み」の印

`AssetText` の有無では判定できない (喋っていない動画は本文が空で行が増えないので、毎回 Groq に送り直して課金される)。そこで `Asset.transcribedAt` / `transcribeError` を持つ。

| 結果 | `transcribedAt` | `transcribeError` | cron |
|---|---|---|---|
| 保存した / 喋っていなかった / 音声トラックが無い (Groq の `no_audio_stream`) | 立てる | null | 拾わない |
| 送り直しても直らない (25 MB 超・Groq の 400 / 413 / 415) | 立てる | 理由 | 拾わない |
| 一時的 (Drive の失敗・Groq の 429 / 5xx / 401・通信) | 立てない | — | 次の回に拾い直す |

1 回の cron は新しい順に最大 15 件 (Groq の無料枠は 20 回 / 分)、240 秒で打ち切る。429 が返ったらその回は打ち切る。`/status` の `cron.transcribe` に件数を残し、1 件も進まず全部が一時的な失敗だった回 (キーの誤り・Groq の障害) は異常にする。

## 費用

whisper-large-v3 は $0.111 / 音声 1 時間、1 回あたり最低 10 秒の課金 (https://groq.com/pricing, 2026-10-27)。トーク 207 件 (送るのは音声トラックのある 98 件) で数十円程度の見込み。

**2026-10-27 時点は無料枠で動かしている。** Developer プランへの切り替えが Groq 側で「需要過多のため一時停止」になっていた。無料枠の上限は 20 回 / 分・2,000 回 / 日・音声 7,200 秒 / 時間・28,800 秒 / 日・25 MB で、トーク (1 件 20 秒前後、1 日数件) には足りる。手動ボタンを大量に押す・長い動画を回すようになったら Developer に上げる。無料枠のうちも `/costs` には有料の単価で出る (実際の請求は 0 円)

利用量は `/costs` に `provider = groq` / `feature = akashic.transcribe` で自己申告する。**`inputTokens` に課金秒数を入れる** (`docs/costs-design.md`)。Groq は後払いなので残高の判定はしない。

## 環境変数

- `GROQ_API_KEY` — 未設定なら cron は何もしない (200 で `skipped`)。ボタンはエラーを出す

## Groq のデータの扱い

Groq は既定で推論の入出力を保持しない (利用量のメタデータは残る)。保持するのは batch / fine-tuning のファイルだけで、どちらも使っていない (https://console.groq.com/docs/your-data)。Data Controls で Zero Data Retention を有効にできる。
