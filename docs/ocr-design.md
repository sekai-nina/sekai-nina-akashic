# 画像の OCR (#379)

雑誌のページなど、文字を含む画像アセットは中身がテキストになっていないので検索に引っかからない。Claude で書き起こし、`AssetText(textType = ocr)` に置いて PGroonga 検索に載せる。作りは文字起こし (`docs/transcribe-design.md`, #282) に揃えている。

## いつ回るか

| 経路 | 対象 | 入口 |
|---|---|---|
| 自動 (15 分ごと) | 「まとめて OCR」で頼まれた画像で、まだのもの。**頼まれていない画像は回さない** (何を OCR するかは人が決める。タグ等で自動的に拾わない) | `GET /api/cron/ocr` (`vercel.json`、`CRON_SECRET` 必須) |
| まとめて | 親アセットの子の画像をまとめて OCR 待ちにする (`Asset.ocrRequestedAt`)。回すのは cron | アセット詳細の子アセット一覧の「まとめて OCR」(admin / member) |
| 手動 | 画像を 1 件ずつ。やり直しもここ | アセット詳細の「OCR」パネル (admin / member) |

- **外部 (Anthropic, 米国) に送るのは `public` / `internal` だけ。** `confidential` / `restricted` は自動でも手動でも送らない。cron は RLS をバイパスする `prismaInternal` なので、`classification` を明示して絞っている。送る直前にもう一度 classification を読み直す
- cron は頼まれた順に 1 回 10 件まで (1 件 10〜40 秒)。雑誌 1 冊 (約 100 ページ) は数時間で片付く

## 流れ

1. Drive から取る (`downloadFromDrive`)
2. `sharp` で長辺 2576px (Claude の高解像度の上限) に収めた JPEG にする (`src/lib/ocr/claude.ts`)。5 MB の上限を超えないように
3. `claude-opus-5-5` (effort `low`) に送る。紙面の順 (縦書きは右の列から) にすべて書き起こし、直さない・推測で補わない・説明を書かないように指示する。文字が無ければ `NO_TEXT` を返させて空にする。安全分類器の誤判定に備えて `fallbacks: "default"` を付ける
4. 本文があれば `addTextRevision` で `AssetText(ocr)` を作る。やり直しで変わったら旧本文を版に残す。**文字が無かったときは既存の本文を消さない**。cron は ocr が既にあるアセットを拾わない (人が入れた本文を上書きしない)
5. `Asset.ocrAt` を立てる (生 SQL。`@updatedAt` を動かさない)。「まとめて OCR」の `ocrRequestedAt` も生 SQL
6. 利用量を `recordUsage` で `/costs` に自己申告する (feature `akashic.ocr`)

## 失敗の扱い

| 種類 | 例 | 扱い |
|---|---|---|
| やり直しても直らない | 画像が読めない・5 MB に収まらない・Drive に無い (404)・Claude が断った・出力が上限で切れた | `ocrAt` と `ocrError` を立てて cron の対象から外す。パネルに理由を出す |
| 一時的 | Drive の 403 / 5xx、Claude の 5xx | 何も書かない。次の回に拾い直す |
| ほかの画像でも同じ | キーの誤り・レート制限 (429)・Drive の認証情報が無い | その回を打ち切る。`/status` の `cron.ocr` を異常にする |

## 費用

1 ページ (画像 約 4,800 トークン + 出力 1,000〜2,000 トークン) で $0.03〜0.05。雑誌 1 冊 (約 100 ページ) で $3〜5。安くするなら `OCR_MODEL` を `claude-sonnet-5-5` にする (約半分)。
