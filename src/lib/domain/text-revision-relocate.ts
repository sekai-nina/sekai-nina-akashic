import { locateExcerpt } from "@/lib/meetgreet/excerpt";
import { stripImagePlaceholders } from "@/lib/utils";

/**
 * 本文が新しい版に変わったとき、抜粋 (クリップ / 記事の出典) の範囲を新しい本文で探し直す (#262)。
 *
 * - 旧範囲のまま新本文でも同じ抜粋になるなら `"keep"`
 * - 新本文に抜粋が 1 か所だけあれば、その範囲
 * - 見つからない・2 か所以上ある (どれか決められない) なら `null`。呼び出し側は範囲を触らず、
 *   アセット詳細では今までどおり「位置未確定」になる
 *
 * 抜粋は画像プレースホルダを除いた文字列で持つので、照合も `stripImagePlaceholders` で揃える
 * (`clips.ts` の `excerptOf` と同じ)。プレースホルダをまたいだ抜粋は直接は見つからないことがある。
 */
export function relocateExcerpt(
  content: string,
  excerpt: string,
  start: number,
  end: number
): "keep" | { start: number; end: number } | null {
  if (!excerpt.trim()) return null;
  if (start >= 0 && end > start && end <= content.length && stripImagePlaceholders(content.slice(start, end)) === excerpt) {
    return "keep";
  }
  const first = locateExcerpt(content, excerpt);
  if (!first) return null;
  if (locateExcerpt(content, excerpt, first.start + 1)) return null;
  // locateExcerpt は空白の違いを無視しても探すので、見つかった範囲が抜粋と一字一句同じとは限らない。
  // 違うとアセット詳細のハイライト (excerptOf との一致で判定) に出ないので、付け直さない
  if (stripImagePlaceholders(content.slice(first.start, first.end)) !== excerpt) return null;
  return first;
}
