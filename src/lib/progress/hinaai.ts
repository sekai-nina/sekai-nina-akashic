/**
 * ひなあい (日向坂で会いましょう) の記事化の進捗 (#208) の純粋関数。
 *
 * 回は Akashic の動画アセットの題 (`日向坂で会いましょう【…】#383` / `まだまだ！日向坂で会いましょう【…】#383`)
 * から拾う。出演一覧の行は「…日向坂で会いましょう出演一覧」記事の表の 1 列目 (`| 383 |`) で判定する
 * (Discord bot の `lemino_article` が足す行と同じ形)。
 */

/** ひなあいの動画アセットか (本編・まだまだ。スタジオライブ等の別イベントは回番号を持たないので落ちる) */
export function hinaaiEpisodeOf(title: string): number | null {
  if (!title.includes("日向坂で会いましょう")) return null;
  const m = title.match(/#(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/** 「まだまだ！日向坂で会いましょう」(Lemino の延長版) か */
export function isMadamada(title: string): boolean {
  return title.startsWith("まだまだ！");
}

/** `日向坂で会いましょう【宮崎が似合う女決定戦】#372` → `宮崎が似合う女決定戦` */
export function hinaaiSubtitle(title: string): string {
  return title.match(/【(.+)】/)?.[1] ?? title;
}

/** 出演一覧の記事か (`【2年目】日向坂で会いましょう出演一覧` など。年ごとに分かれている) */
export function isHinaaiListTitle(title: string): boolean {
  return title.endsWith("日向坂で会いましょう出演一覧");
}

/** 出演一覧の表に行がある回 */
export function listedEpisodes(body: string): Set<number> {
  return new Set([...body.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1])));
}
