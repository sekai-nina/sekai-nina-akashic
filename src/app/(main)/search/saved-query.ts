/**
 * 直近の検索 URL の保存。
 *
 * 結果を見に行って戻ってきたときにフィルタを復元するために使う。保存先は
 * sessionStorage（タブを閉じれば消える）で、さらに TTL を切っている。localStorage に
 * 永続化していた頃は、久しぶりに開いたトップページで過去のクエリが勝手に検索されて
 * いた。「新しく検索を始めたい」訪問では復元しない。
 *
 * 呼び出し元は effect とクリックハンドラだけなので、SSR ガードは置いていない。
 */

const STORAGE_KEY = "search-last-query";
/** 結果を 1 件読んで戻ってくるには十分で、「久しぶりに開いた」には届かない長さ */
const SAVED_QUERY_TTL_MS = 30 * 60 * 1000;

interface SavedQuery {
  /** `?` 始まりのクエリ文字列 */
  qs: string;
  savedAt: number;
}

/** 保存が無い・期限切れ・壊れているときは null */
export function readSavedQuery(): string | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<SavedQuery>;
    if (typeof saved.qs !== "string" || !saved.qs.startsWith("?")) return null;
    if (typeof saved.savedAt !== "number" || Date.now() - saved.savedAt > SAVED_QUERY_TTL_MS) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return saved.qs;
  } catch {
    return null;
  }
}

export function saveQuery(qs: string) {
  try {
    const saved: SavedQuery = { qs, savedAt: Date.now() };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // プライベートモード等で storage が使えなくても検索自体は動かす
  }
}

export function clearSavedQuery() {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上
  }
}
