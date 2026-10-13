/**
 * 番組の回ごとの記事化の進捗 (#208 ひなあい / まだまだ / ひななり) の純粋関数。
 *
 * 回は Akashic の動画アセットの題 (`日向坂で会いましょう【…】#383` / `日向坂になりましょう【…】#7`) の
 * 末尾の回番号から拾う。出演一覧の行は「…出演一覧」記事の表の 1 列目 (`| 383 |` / `| 1a |`) で判定する。
 */

export type ShowKey = "hinaai" | "madamada" | "hinanari";

/** 「まだまだ！日向坂で会いましょう」(Lemino の延長版)。題に「日向坂で会いましょう」を含むので、ひなあいからは外す */
const MADAMADA_MARKER = "まだまだ！日向坂で会いましょう";

export interface Show {
  key: ShowKey;
  /** タブ・見出し */
  label: string;
  /** 動画アセットの題に含まれる番組名 */
  titleMarker: string;
  /** 番組名を含んでも別番組として外す題 (ひなあいから見たまだまだ)。動画・出演一覧の記事の両方に効く */
  excludeMarker?: string;
  /** 出演一覧の記事の題の末尾 (`【2年目】…出演一覧` のように年ごとに分かれている) */
  listTitleSuffix: string;
  /** 本編以外の動画 (番外編) の呼び名。本編だけの番組は省く */
  extraLabel?: string;
  /** 本編以外の動画か */
  isExtra: (title: string) => boolean;
  /** 出演一覧の行の足し方 (画面の説明に出す) */
  listHint: string;
  /** 「行を足す」で人が入れる列 (表の見出しの列名)。`mark` は ○ / — */
  listCells: { name: string; kind: "mark" | "text" }[];
}

const GENDOU_CELLS: Show["listCells"] = [
  { name: "言動", kind: "mark" },
  { name: "補足", kind: "text" },
];

export const SHOWS: Record<ShowKey, Show> = {
  hinaai: {
    key: "hinaai",
    label: "ひなあい",
    titleMarker: "日向坂で会いましょう",
    excludeMarker: MADAMADA_MARKER,
    listTitleSuffix: "日向坂で会いましょう出演一覧",
    isExtra: () => false,
    listHint: "Discord の 📤 で追加",
    listCells: GENDOU_CELLS,
  },
  // #371 (2026-07) から本編と同じ回番号で配信されている
  madamada: {
    key: "madamada",
    label: "まだまだ",
    titleMarker: MADAMADA_MARKER,
    listTitleSuffix: "まだまだ！日向坂で会いましょう出演一覧",
    isExtra: () => false,
    listHint: "出演一覧の記事に手で追加",
    listCells: GENDOU_CELLS,
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
    listCells: [{ name: "ゲスト", kind: "text" }],
  },
};

/** 番組の動画アセットなら回番号 (スタジオライブ等の別イベントは回番号を持たないので落ちる) */
export function episodeOf(show: Show, title: string): number | null {
  if (!title.includes(show.titleMarker) || isExcluded(show, title)) return null;
  // 題の末尾に改行が付いたものがある
  const m = title.match(/#(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/** `日向坂で会いましょう【宮崎が似合う女決定戦】#372` → `宮崎が似合う女決定戦` */
export function subtitleOf(title: string): string {
  return title.match(/【(.+)】/)?.[1] ?? title;
}

export function isListTitle(show: Show, title: string): boolean {
  return title.endsWith(show.listTitleSuffix) && !isExcluded(show, title);
}

function isExcluded(show: Show, title: string): boolean {
  return show.excludeMarker !== undefined && title.includes(show.excludeMarker);
}

/** 出演一覧の表に行がある回。番外編の行は `1a` / `14b` のように枝番が付く */
export function listedEpisodes(body: string): Set<number> {
  return new Set([...body.matchAll(/^\|\s*(\d+)[a-z]?\s*\|/gm)].map((m) => Number(m[1])));
}
