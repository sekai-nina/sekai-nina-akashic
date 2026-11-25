/** 生成に失敗したときに出す文。ワーカーのログは利用者には見えないので、できることだけを書く */
export const SCENE_FAILED_MESSAGE = "「もう一度生成する」でやり直せます。元動画からのスクショ・範囲の保存は、生成しなくてもできます";
/** 以前に保存した失敗の文 (利用者には読めないログを指していた)。画面では SCENE_FAILED_MESSAGE に置き換える */
export const LEGACY_SCENE_FAILED_MESSAGE = "動画を処理できませんでした。ワーカーのログを確認してください";

export const SCENE_LABELS = {
  title: "動画の場面", queued: "生成待ち", processing: "生成中", ready: "生成済み", failed: "生成に失敗しました",
  create: "場面候補を作る", retry: "もう一度生成する", source: "元動画を通して見る", browse: "場面から探す", none: "未生成",
} as const;
