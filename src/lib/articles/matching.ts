import { jstDayString } from "@/lib/utils";

/**
 * frontmatter の source[] を Asset に解決するときの候補選び。
 *
 * `Asset.title` にも `SourceRecord.url` にも一意制約が無いので、**候補は常に
 * 複数ありうる**。後勝ちで 1 件選ぶと無関係な Asset に `applied` として
 * 紐づき、記事の出典が静かに間違う (実データで 7 件発生していた)。
 */

/** 照合候補。日付で絞るために Asset.canonicalDate を持つ */
export type Candidate = { id: string; date: Date | null };

/** 解決に失敗した理由。ログに出して人が追えるようにする */
export type FailReason =
  /** ref が書かれているが Asset が存在しない */
  | "dangling"
  /** 手がかりに一致する Asset が無い */
  | "not_found"
  /** 一致する Asset が 2 件以上あり、日付でも絞れない */
  | "ambiguous"
  /** 一致する Asset はあるが日付が食い違う (JST 比較) */
  | "date_mismatch"
  /** 手がかりが何も無い */
  | "no_clue";

export const FAIL_REASON_LABELS: Record<FailReason, string> = {
  dangling: "ref が指す Asset が無い",
  not_found: "一致する Asset が無い",
  ambiguous: "候補が複数あり日付でも絞れない",
  date_mismatch: "候補はあるが日付が食い違う",
  no_clue: "手がかりが無い",
};

export type PickResult = { id: string | null; reason?: FailReason; candidates?: number };

/** 候補マップに 1 件足す (同じ Asset は重複させない) */
export function addCandidate(map: Map<string, Candidate[]>, key: string, c: Candidate): void {
  const list = map.get(key);
  if (!list) map.set(key, [c]);
  else if (!list.some((x) => x.id === c.id)) list.push(c);
}

/**
 * 候補から 1 件に決める。決められなければ理由を返す。
 *
 * 日付は **JST で比較する**。`Asset.canonicalDate` は日付のみの値を JST 深夜
 * (= 15:00 UTC 前日) で持つのに対し、frontmatter 由来の日付は UTC 深夜なので、
 * 素の UTC 日付で突き合わせると常に 1 日ずれる (実測で 2642 件の Asset が該当)。
 *
 * 記事側に日付があるとき、日付を持つ候補には一致を要求する。同一ラベルで
 * 日付だけ違うエントリ (attribute/癖.md の `^[2]` `^[3]` が 3/7 と 3/20) が
 * 同じ Asset に吸い込まれるのを防ぐため。
 */
export function pickCandidate(cands: Candidate[] | undefined, entryDate: Date | null): PickResult {
  if (!cands || cands.length === 0) return { id: null, reason: "not_found" };

  if (entryDate) {
    const dated = cands.filter((c) => c.date != null);
    if (dated.length) {
      const day = jstDayString(entryDate);
      const matched = dated.filter((c) => jstDayString(c.date!) === day);
      // 日付を持たない候補は日付で否定できないので残す
      const pool = [...matched, ...cands.filter((c) => c.date == null)];
      if (pool.length === 0) return { id: null, reason: "date_mismatch", candidates: cands.length };
      if (pool.length === 1) return { id: pool[0].id };
      return { id: null, reason: "ambiguous", candidates: pool.length };
    }
  }

  if (cands.length === 1) return { id: cands[0].id };
  return { id: null, reason: "ambiguous", candidates: cands.length };
}
