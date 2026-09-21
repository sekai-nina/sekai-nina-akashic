/**
 * 生成した記事の保存 (#109) — ミーグリ向けの薄い入口。
 *
 * 中身は #170 でテンプレート共通の `article-generate.ts` に移った。ここは器を
 * `{ kind: "meetgreet" }` に包んで呼ぶだけで、画面 (`(main)/meetgreets/actions.ts`) と
 * REST (`/api/v1/meetgreets/:id/article`) の import 元を変えずに済ませている。
 */

import type { ArticleMode, ArticlePreview } from "@/lib/meetgreet/types";
import type { ActingUser } from "./meetgreets";
import {
  previewArticle,
  restoreExclusions,
  saveArticle,
  type MeetGreetForArticle,
  type SaveArticleResult,
} from "./article-generate";

export type { ArticleMode, ArticlePreview, MeetGreetForArticle, SaveArticleResult };
export { bodyDigest } from "./article-generate";

/**
 * 生成結果を見せる (DB には書かない)。
 * 既存記事があれば追記の差分、無ければ新規作成の本文を返す。
 */
export function previewMeetGreetArticle(
  user: ActingUser,
  meetGreet: MeetGreetForArticle,
  /** まだ保存していない「外すつもり」のキー。本文にだけ効かせて DB には書かない */
  extraExclude: readonly string[] = []
): Promise<ArticlePreview> {
  return previewArticle(user, { kind: "meetgreet", meetGreet }, extraExclude);
}

/** 「今後足さない」を取り消す。次のプレビューからまた候補に出る (#134) */
export function restoreMeetGreetExclusions(
  user: ActingUser,
  meetGreet: MeetGreetForArticle,
  keys: readonly string[]
): Promise<number> {
  return restoreExclusions(user, { kind: "meetgreet", meetGreet }, keys);
}

/** 生成結果を保存する。新規なら作成、既存なら追記 */
export function saveMeetGreetArticle(
  user: ActingUser,
  meetGreet: MeetGreetForArticle,
  /** 画面が見せたプレビューの指紋。渡すと、組み立て直した結果が変わっていたら中止する */
  expectedDigest?: string,
  /** 今回「足さない」と決めたもののキー。除外リストに追加してから組み立て直す (#134) */
  exclude: readonly string[] = []
): Promise<SaveArticleResult> {
  return saveArticle(user, { kind: "meetgreet", meetGreet }, expectedDigest, exclude);
}
