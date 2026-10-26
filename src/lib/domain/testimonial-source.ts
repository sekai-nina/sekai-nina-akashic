/**
 * 口コミはメンバー本人のブログ (/diary/detail/<id>) からだけ拾う。
 * 運営のひなたぼっこ日記 (/diary/manager/...) など他の web 資料は著者が公式アカウントで、
 * 語った人がグループ名になってしまうので対象外
 */
export function isMemberBlogUrl(url: string | null | undefined): boolean {
  return /hinatazaka46\.com\/s\/official\/diary\/detail\/\d+/.test(url ?? "");
}
