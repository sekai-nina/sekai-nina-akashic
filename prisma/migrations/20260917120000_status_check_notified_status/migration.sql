-- StatusCheckState に notifiedStatus を足す (#100 レビュー対応)
--
-- 通知の遷移判定を「前回の status」と比べていると、Discord への送信に失敗した回の
-- 遷移が失われる (error → ok の送信に失敗すると次は ok → ok で判定 null になり、
-- 復旧の一報が永久に出ない)。「最後に通知できた status」を別に持ち、そこと比べる。
-- 送れなかった回はこの列を進めないので、次の評価で同じ遷移をもう一度送れる。
--
-- nullable の追加列。手動 GRANT は不要 (列の権限はテーブル単位)。
-- 先行 2 本 (20260917100000 / 20260917110000) は 2026-09-16 に本番へ適用済み。
-- 本番は SQL を先に当ててからデプロイする (旧コードはこの列を参照しない)。

-- AlterTable
ALTER TABLE "StatusCheckState" ADD COLUMN     "notifiedStatus" "StatusLevel";
