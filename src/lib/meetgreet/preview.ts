/**
 * 予告コーデ (#203) の純粋関数。REST の射影と公開サイトの表示で使う。
 */

/**
 * 出典の表示名。トークのアセットはタイトル末尾に投稿日時が付いている
 * (`坂井新奈トーク 2026.4.22 16:37`) ので落とす。日付は別に出すため。
 */
export function previewSourceLabel(title: string): string {
  return title.replace(/\s+\d{4}\.\d{1,2}\.\d{1,2}(?:\s+\d{1,2}:\d{2})?\s*$/, "").trim() || title;
}

/**
 * 出典欄の入力 (改行・空白・カンマ区切り) をアセット ID の並びにする。
 * Akashic のアセット URL (`…/assets/<id>`) を貼っても ID だけ取り出す。
 */
export function parseAssetRefs(text: string): string[] {
  const ids = text
    .split(/[\s,、]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => t.match(/\/assets\/([a-z0-9]+)/)?.[1] ?? t);
  return [...new Set(ids)];
}
