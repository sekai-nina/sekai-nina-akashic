# Discordメモからの候補クリップ取り込み

「新奈メモ」「フィールドワーク」に書かれた仮メモを、承諾後に Akashic の素材として
取り込む運用。Issue #233 の素材クリップ進捗とは別に、素材の入口を増やすための仕組みである。

## 合意した運用

1. ふぃたんが毎日 09:00 JST に2チャンネルの新着を確認する
2. 新着を候補として要約し、元投稿と同じチャンネルで人へ提示する
3. 人が明示的に承諾した候補だけを MCP 経由で登録する
4. Akashic は `inbox` の text Asset として保存し、既存のクリップ・ドシエ・記事作成へつなぐ

承諾しなかった候補は Akashic に保存しない。投稿後に Discord で編集・削除されても、
保存済みアセットを同期しない。添付ファイルは初回の対象外である。

## MCP の契約

`akashic_import_discord_memo` は `write` 権限のキーだけに公開する。

- `channel` は `nina_memo` または `fieldwork`
- Discord の guild / channel / message ID とメッセージ URL の一致を検証する
- 本文、投稿者、投稿時刻、承諾済みの短いタイトルを受ける
- classification は省略すると `internal`。人が承諾時に指定した場合だけ変更する
- `(guildId, channelId, messageId)` は Asset 上で一意。同じ投稿への再実行は既存アセットを返す

アセットの `canonicalDate` は投稿時刻から求める JST 暦日、`discordPostedAt` は元の時刻を保持する。
本文は `AssetText(body)` として保存し、元メッセージ URL は `SourceRecord(discord_message)` にも残す。

## ふぃたん側に必要な設定

ふぃたんには対象2チャンネルの Discord ID と、Akashic の write 権限付き MCP キーを設定する。
巡回処理は前回確認した message ID 以降だけを候補にし、投稿者・本文・メッセージ URL を読み取る。
候補の承諾は、候補を提案した後の返信でのみ有効にする。これはミーグリappの issue
候補と同じ承諾方式で、過去の「OK」を別候補へ使い回さないためである。

Akashic が受け取るのは承諾済みの投稿だけであり、Discord を読んだり、定時実行したりはしない。
