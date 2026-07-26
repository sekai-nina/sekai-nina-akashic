/**
 * 検索ページが解釈する URL パラメータの一覧。
 *
 * 表示切替・ページ送り・再検索のたびにリンクを組み直しているので、ここに
 * 載っていないパラメータは黙って捨てられる。新しい絞り込みを足すときは
 * 必ずここにも追加すること。
 */
export const SEARCH_PARAM_KEYS = [
  "q",
  "kind",
  "entityIds",
  "entityMatch",
  "authorIds",
  "dateFrom",
  "dateTo",
  "target",
  "sourceType",
  "view",
  "page",
] as const;

/**
 * フォームの UI からは編集できないが、URL に付いていれば引き継ぐべきパラメータ。
 * （テキスト分析からの遷移などで付いてくる）
 */
export const CARRIED_PARAM_KEYS = ["target", "sourceType", "view"] as const;
