# 公開サイトの鮮度表示への整理（#233 段階3）

## 合意

2026-10-18、ユーザーは「観点×データソースごとの確認済み日付を直接更新する」方式に「はい」と回答した。[Issueの合意記録](https://github.com/sekai-nina/sekai-nina-akashic/issues/233#issuecomment-6235529594)。

- `/coverage` は公開サイトの鮮度表示に絞り、日付を直接更新する。
- 観点ごとのアイテムチェック操作と件数の割合表示を終了する。
- 既存チェックは保存し、クリップ済へ読み替えない。
- 素材作業は `/progress` で管理する。記事生成の段階2（PR #235）と段階1（PR #234）はマージ済み。

## 保存先と理由

既存 `Coverage` に2列を追加する。観点×ソースの一意制約・機密・対象外・内部メモ・監査対象が既にあり、別テーブルは不要。

| 列 | 用途 |
|---|---|
| confirmedUntil DATE nullable | 確認済み日付（JSTの暦日） |
| freshnessUpdatedAt timestamp nullable | 直接設定した日時。未入力と明示的な未確認を区別 |

freshnessUpdatedAt が null の間だけ、従来の可視のチェックと導出素材で日付を表示する。同日に未チェックがあればその日は含めない。初回編集後は保存値だけを使う。日付を空に戻しても旧日付は復活しない。

APIで日付を省略すれば保持、nullなら未確認へ戻す。状態・メモの省略も既存値を保持。メモだけのAPI更新では旧記録からの日付表示を維持する。UI保存時は表示中の日付を明示保存する。

旧チェックの削除・バックフィル・一括本番更新はない。未編集セルの旧日付は、従来どおり素材追加・変更の影響を受ける。直接入力した後は素材増減によって変わらない。

## 実装

- `/coverage` は年を含む日付・未確認・対象外だけを表示し、セルから日付/対象外/内部メモのnative dialogを開く。保存失敗時は入力を保持。viewerは閲覧のみ。
- アセット詳細の観点パネルと関連照会を撤去し、クリップ済の操作を残す。
- 旧 `/coverage/[sourceKey]` は認証・RLSでソースを確認し、標準12ソースを素材進捗へ、独自ソースを `/coverage` へ転送する。
- 旧観点チェックのドメイン書き込みとServer Actionを撤去。単一/一括の旧RESTは認証・write検証後410。
- 旧GET `/coverage/items` は履歴参照用に残す。著者・言及判定、DataSourceの導出設定は素材進捗でも使うため維持。
- withClearance、親・既存セルの最大機密継承、assertClearance。同一セルの初回もadvisory lockで直列化し、並行保存による機密引き下げを防ぐ。
- 見えない行との衝突は安全な権限エラーを返す。高権限の存在確認はしない。
- 旧記録のある未編集ソースだけ導出。ソースあたり一回、最大3並列。直接入力済みでは旧チェックも素材全件も読まない。

## 公開サイトとAPI

Akashicの要約 → stats Worker/KV → 公開サイト `/status`。WorkerはJSON中継のためコード変更不要（最大30分待ち）。

- continuousUntilのキー名を維持し、確認済み日付として返す。確認済み件数/総数は廃止。
- public・activeな観点とソースのうち対象外を除いて公開。素材未登録のソースでも日付を管理できる。内部メモ・設定日時・機密は要約に出さない。
- 公開サイトは新旧どちらの応答でも日付だけを表示し、日付なしは未確認。更新日時もJST。
- 動的DOMのスタイルは `.status-page` 配下のglobal CSSで適用し、他ページへの影響を避ける。

## 検証

- `pnpm typecheck` 成功。
- `pnpm test`: 769 passed / 8 skipped（59ファイル成功・2ファイルskip）。JST境界、不正暦日、同日未チェック、明示null、省略時保持、機密・ロック・権限競合、公開射影、旧API終了、独自ソース転送を含む。
- 公開サイト `pnpm astro check`: 0 errors / 0 warnings、既存の24 hints。記事サブモジュールが未展開のworktreeでの検証。
- 公開サイト `node --test scripts/status.test.mjs`: 5件成功。新旧応答、日付未設定、HTTP/応答エラー、JSTの更新日、HTMLとして解釈しない名前表示。
- schema同士の `prisma migrate diff` でnullable2列だけの差分を確認。本番へ接続して差分生成しない。
- ローカルの一時PostgreSQL17で、migration・既存行と旧チェック保持・既存RLS4種/ENABLE/FORCE・既存GRANTでの日付更新・明示null・下位/未設定clearance拒否を確認。コンテナは停止・削除済み。
- reviewスキルの3観点レビュー実施。独自ソースの転送先修正を再確認し、残る指摘なし。
- 実コンポーネントをローカルでbundleし、保存処理だけfixtureに置換したChrome検証で、native dialogの開閉・日付変更・保存失敗時の入力保持・保存後の再表示要求・空への解除・viewer操作禁止を確認。
- 公開サイトのChromeローカルfixtureで、新旧API・未設定の表示、件数非表示、動的DOMへのgrid適用を確認し、スクリーンショットを目視確認。
- 認証済み本番ブラウザでの操作確認は未実施。ローカルfixtureの確認と区別する。

## 本番適用手順（未実施）

1. 公開サイト側の変更を先にマージ・反映し、旧API応答でも日付表示できることを確認する。
2. ユーザー承認後、Akashicのmigration `20261018000000_coverage_freshness` を本番適用する。既存コードと互換性のあるnullable列追加のみ。新規テーブルがないため追加GRANT不要。
3. migration適用後にAkashicの新コードをマージ・反映する。自動デプロイより先にDB列を用意する。
4. 本番画面で日付編集・空への解除・対象外・viewer閲覧を確認し、公開サイトの反映を確認する。旧表示が残る場合はページを再読込し、Worker更新を待つ。

本番migration・本番データ書き込み・環境変数変更・デプロイ・マージは実施していない。コミット・PR作成は継続作業での承認範囲に沿って行う。

## 完了条件

- [x] 観点×ソースの直接日付更新に合意し、Issueへ記録
- [x] 保存先・旧記録の保持・明示nullを実装
- [x] 観点アイテムチェックの操作を終了
- [x] 公開サイトを日付表示へ変更し、新旧API互換を検証
- [x] 型チェック・テスト・レビュー
- [x] PRへ提出する実装・検証・適用手順を用意。本番migrationは未適用
- [ ] 承認後の本番適用と認証済み実画面での確認

## 変更ファイル一覧

### Akashic

- `docs/api.md`
- `docs/clip-progress-design.md`
- `docs/coverage-design.md`
- `docs/coverage-phase3-design.md`
- `docs/security-dev.md`
- `prisma/migrations/20261018000000_coverage_freshness/migration.sql`
- `prisma/schema.prisma`
- `src/app/(main)/assets/[id]/coverage-panel.tsx`
- `src/app/(main)/assets/[id]/page.tsx`
- `src/app/(main)/coverage/[sourceKey]/items-client.tsx`
- `src/app/(main)/coverage/[sourceKey]/page.test.ts`
- `src/app/(main)/coverage/[sourceKey]/page.tsx`
- `src/app/(main)/coverage/actions.ts`
- `src/app/(main)/coverage/coverage-client.tsx`
- `src/app/(main)/coverage/page.tsx`
- `src/app/(main)/coverage/scroll-memory.tsx`
- `src/app/(main)/layout.tsx`
- `src/app/api/v1/coverage/checks/bulk/route.ts`
- `src/app/api/v1/coverage/checks/route.test.ts`
- `src/app/api/v1/coverage/checks/route.ts`
- `src/app/api/v1/coverage/route.test.ts`
- `src/app/api/v1/coverage/route.ts`
- `src/components/sidebar.tsx`
- `src/lib/coverage/freshness.test.ts`
- `src/lib/coverage/freshness.ts`
- `src/lib/domain/coverage-freshness.test.ts`
- `src/lib/domain/coverage-items.ts`
- `src/lib/domain/coverage.ts`
- `src/lib/utils.ts`

### 公開サイト（別リポジトリ）

- `src/pages/status.astro`
- `scripts/status.test.mjs`
- `docs/coverage-freshness.md`
