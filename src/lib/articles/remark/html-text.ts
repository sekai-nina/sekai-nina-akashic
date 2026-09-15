/**
 * 生 HTML 文字列のうち、タグの外側 (テキストノード相当) だけを置換する。
 *
 * 先行プラグインが作った html ノードの value 全体に正規表現をかけると、
 * 属性値の中の `^[1]` や `[[...]]` まで置換してしまい、挿入した HTML の
 * 引用符で属性が閉じて DOM が壊れる。タグ境界で分割して外側だけ触る。
 */
export function replaceOutsideTags(html: string, fn: (text: string) => string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += fn(html.slice(i));
      break;
    }
    out += fn(html.slice(i, lt));
    const gt = html.indexOf(">", lt);
    if (gt === -1) {
      // 閉じていないタグ。触らずそのまま残す
      out += html.slice(lt);
      break;
    }
    out += html.slice(lt, gt + 1);
    i = gt + 1;
  }
  return out;
}
