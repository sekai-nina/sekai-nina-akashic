import type { StatusLevel } from "@prisma/client";
import type { CheckGroup } from "@/lib/utils";

/**
 * パイプライン監視 (/status) の型と定義表。
 *
 * チェックは 2 系統ある:
 *   - データ由来: akashic の DB を見て「最終登録がいつか」「未処理が何件か」を導出する。
 *     bot の改修は要らないが「新着が無いだけ」と「bot が死んだ」を区別できない
 *   - ハートビート: bot / ワーカーの各ジョブが実行ごとに結果を報告する (Job / JobRun)。
 *     失敗理由も届く。報告が来ない・error が来たジョブを検知する
 *
 * チェックの定義はコードに持つ (閾値も含む)。DB に持っても結局クエリはコードに要るため。
 */

/** 1 回の評価でチェックが返すもの。StatusCheckState にそのまま保存する */
export interface CheckOutcome {
  status: StatusLevel;
  /** 一覧の 1 行に出す要約 (「最終登録 12 分前」「未抽出 3 件」) */
  summary: string;
  /** 展開で出す補足。形はチェックごと (`(main)/status/check-detail.tsx` が描画できる形に揃える) */
  detail?: Record<string, unknown>;
}

export interface CheckDefinition {
  /** `<group>.<name>`。StatusCheckState.key と通知の識別子 */
  key: string;
  group: CheckGroup;
  name: string;
  /** 一覧に出す短い説明 (何を見ているか) */
  description: string;
  /**
   * false なら Discord に通知しない (件数を眺めるだけの info チェック)。
   * inbox 滞留やサムネイル未生成のように常に何件かある指標を warn にしない
   */
  notify: boolean;
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

export interface CheckContext {
  now: Date;
}

/**
 * データ由来の鮮度チェックの閾値 (時間)。DataSource.key ごと。
 *
 * 直近 60 日の登録間隔の実測 (最大ギャップ) から: blog 70h / talk 40h / Lemino 168h。
 * ここに無い DataSource (雑誌・SNS・完結した番組) は見ない。
 * YouTube 系 (hinachan / official_ch) は DataSource の titlePattern が youtube_watch の
 * 登録形式と合っておらず常に warn になるので、パターンを直すまで外している (#101)。
 */
export const SOURCE_FRESHNESS_MAX_AGE_HOURS: Record<string, number> = {
  blog: 72,
  talk: 48,
  hinaai: 24 * 10,
};

/**
 * ハートビートを期待するジョブ。報告が一度も無ければ「未報告」(unknown) と出す。
 * 報告側の key と一致させる (sekai-nina-discord-bot#30)。
 * ここに無い key で報告が来たジョブも一覧には出る (グループは workers 扱い)。
 */
export const EXPECTED_JOBS: { key: string; name: string; group: CheckGroup }[] = [
  { key: "bot.blog_watch", name: "bot: ブログ監視", group: "collect" },
  { key: "bot.talk_monitor", name: "bot: トーク監視", group: "collect" },
  { key: "bot.talk_monitor.blog", name: "bot: トーク監視 (ブログ言及)", group: "collect" },
  { key: "bot.site_watch", name: "bot: 公式サイト監視", group: "collect" },
  { key: "bot.youtube_watch", name: "bot: YouTube 監視", group: "collect" },
  { key: "cron.x_mentions", name: "X 言及監視 (日次)", group: "collect" },
  { key: "bot.discovery", name: "bot: 今日の発見の抽出", group: "process" },
  { key: "worker.stats", name: "stats-worker (ダッシュボード集計)", group: "workers" },
  { key: "worker.drive_backup", name: "Drive バックアップ", group: "workers" },
  { key: "worker.sync", name: "sekai-nina-sync", group: "workers" },
];

/** ハートビートが途絶えたと判定するまでの倍率 (intervalSec × 3) と下限 */
export const HEARTBEAT_STALE_FACTOR = 3;
export const HEARTBEAT_STALE_MIN_SEC = 15 * 60;

/** 今日の発見の未抽出を「抽出待ち / 失敗」として警告する期間 (これより古いものは発見なしの回とみなす) */
export const DISCOVERY_WINDOW_DAYS = 7;

/** 未 push の記事がこれより古ければ warn */
export const ARTICLE_DIRTY_MAX_AGE_DAYS = 7;

/** 非 ok が続いているときに再通知するまでの間隔 */
export const RENOTIFY_INTERVAL_HOURS = 24;

/** JobRun を保持する日数 (cron が古いものを消す) */
export const JOB_RUN_RETENTION_DAYS = 30;

/** ok / count 無しの報告は、最新の JobRun 行からこの間隔以内なら行を増やさない */
export const JOB_RUN_DEDUP_SEC = 60 * 60;

/** 1 つのチェックの評価に許す時間。超えたら「評価できず」にして他のチェックの保存を守る */
export const CHECK_TIMEOUT_MS = 15_000;

/**
 * 評価全体の予算。超えたら残りのチェックは走らせず「評価できず」にする
 * (cron の maxDuration 60 秒に収め、保存と通知まで必ず到達させる)。
 */
export const EVALUATION_BUDGET_MS = 40_000;

/**
 * 非 ok になってから通知するまでの確認時間。
 *
 * チェックは 15 分ごとなので、この時間を超える = **2 回続けて同じ非 ok を観測した**ということ。
 * 1 回だけの瞬間的な異常 (DB の接続待ち・GitHub の 5xx・bot の一時的な失敗) で通知が
 * 往復しないようにする。次の評価で ok に戻れば since が巻き戻り、通知は出ない。
 */
export const ALERT_CONFIRM_SEC = 13 * 60;

/** この時間以内に別の評価が走っていたら評価しない (cron と「今すぐ評価」の二重通知を防ぐ) */
export const EVALUATION_MIN_INTERVAL_SEC = 30;

/** bot の自由文 (message) を summary / Discord に載せるときの上限 */
export const SUMMARY_MESSAGE_MAX_CHARS = 200;

/** detail に載せる件数の上限 (全件出すと画面が長くなるだけ) */
export const DETAIL_LIMIT = 20;
