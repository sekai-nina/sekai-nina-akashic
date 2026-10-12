/**
 * 番組の回ごとの記事化の進捗 (#208 ひなあい / ひななり) の純粋関数。
 *
 * 回は Akashic の動画アセットの題 (`日向坂で会いましょう【…】#383` / `日向坂になりましょう【…】#7`) の
 * 末尾の回番号から拾う。出演一覧の行は「…出演一覧」記事の表の 1 列目 (`| 383 |` / `| 1a |`) で判定する。
 */

export type ShowKey = "hinaai" | "hinanari";

export interface Show {
  key: ShowKey;
  /** タブ・見出し */
  label: string;
  /** 動画アセットの題に含まれる番組名 */
  titleMarker: string;
  /** 出演一覧の記事の題の末尾 (`【2年目】…出演一覧` のように年ごとに分かれている) */
  listTitleSuffix: string;
  /** 本編以外の動画 (まだまだ / 番外編) の呼び名 */
  extraLabel: string;
  /** 本編以外の動画か */
  isExtra: (title: string) => boolean;
  /** 出演一覧の行の足し方 (画面の説明に出す) */
  listHint: string;
}

export const SHOWS: Record<ShowKey, Show> = {
  hinaai: {
    key: "hinaai",
    label: "ひなあい",
    titleMarker: "日向坂で会いましょう",
    listTitleSuffix: "日向坂で会いましょう出演一覧",
    extraLabel: "まだまだ",
    // 「まだまだ！日向坂で会いましょう」(Lemino の延長版)
    isExtra: (title) => title.startsWith("まだまだ！"),
    listHint: "Discord の 📤 で追加",
  },
  hinanari: {
    key: "hinanari",
    label: "ひななり",
    titleMarker: "日向坂になりましょう",
    listTitleSuffix: "日向坂になりましょう出演一覧",
    extraLabel: "番外編",
    // `日向坂になりましょう【ザ・ハイテンション番外編】#7` / `【番外編 私もうプロフェッショナルなんです！後半戦】#2`
    isExtra: (title) => subtitleOf(title).includes("番外編"),
    listHint: "出演一覧の記事に手で追加",
  },
};

/** 番組の動画アセットなら回番号 (スタジオライブ等の別イベントは回番号を持たないので落ちる) */
export function episodeOf(show: Show, title: string): number | null {
  if (!title.includes(show.titleMarker)) return null;
  // 題の末尾に改行が付いたものがある
  const m = title.match(/#(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/** `日向坂で会いましょう【宮崎が似合う女決定戦】#372` → `宮崎が似合う女決定戦` */
export function subtitleOf(title: string): string {
  return title.match(/【(.+)】/)?.[1] ?? title;
}

export function isListTitle(show: Show, title: string): boolean {
  return title.endsWith(show.listTitleSuffix);
}

/** 出演一覧の表に行がある回。番外編の行は `1a` / `14b` のように枝番が付く */
export function listedEpisodes(body: string): Set<number> {
  return new Set([...body.matchAll(/^\|\s*(\d+)[a-z]?\s*\|/gm)].map((m) => Number(m[1])));
}
