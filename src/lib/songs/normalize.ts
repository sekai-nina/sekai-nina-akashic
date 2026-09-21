/**
 * 曲名の名寄せキー (#167)。**クライアント部品からも読むので依存を持ち込まない。**
 *
 * NFKC (全角英数・記号を半角に) → 小文字 → 空白と記号 (句読点・記号カテゴリ) を落とす。
 * 「HEY！OHISAMA！」と「HEY!OHISAMA!」、「Am I ready?」と「Am I ready」を同じ曲に寄せるため。
 * 「誰よりも高く跳べ！ 2020」と「誰よりも高く跳べ！」は別の曲 (2020 版は再録) なので数字は残す。
 * DB の `Song.normalizedTitle` はこの関数の値 (migration の仮の値は cli:import-songs が計算し直す)。
 */
export function normalizeSongTitle(title: string): string {
  const folded = title.normalize("NFKC").toLowerCase();
  const key = folded.replace(/[\s\p{P}\p{S}]+/gu, "");
  // 記号だけの題 (「…」等) が空のキーに潰れて別の曲と同じにならないように
  return key || folded.trim();
}
