import { MEMBERS } from "@/lib/members";

/**
 * キャプションから登録内容を組む純粋関数 (#179)。
 *
 * 公式 TikTok のキャプションは「本文 + メンバー名 (絵文字付き) + ハッシュタグ」の形が多い:
 *   「IDOL RUNWAY COLLECTION」ありがとうございました💖📣 片山紗希🐰 佐藤優羽🪽 #日向坂46 #日向坂46_TikTok
 * メンバー名はフルネームがそのまま出るので、名簿 (`src/lib/members.ts`) の名前が含まれるかを
 * 見るだけで person エンティティに紐付けられる。愛称までは追わない (誤爆のほうが痛い)。
 */

const TITLE_MAX = 80;

/** Discord で目立たせるメンバー。このアーカイブの主役 */
export const HIGHLIGHT_MEMBER = "坂井新奈";

/** 名簿の名前のうちキャプションに現れるもの。名簿の並び (期・五十音) のまま返す */
export function extractMemberNames(caption: string, roster: readonly { name: string }[] = MEMBERS): string[] {
  if (!caption) return [];
  return roster.filter((m) => caption.includes(m.name)).map((m) => m.name);
}

const HASHTAG = /#[^\s#＃]+/g;

/**
 * アセットのタイトル。ハッシュタグを落として実のある最初の行を 80 文字に切る
 * (「#タグ だけの行 + 本文」の形でも本文が採れる)。何も残らなければ「@handle YYYY/MM/DD」。
 * 絵文字が多いので**コードポイント単位**で切る (UTF-16 の途中で切るとサロゲートが割れる)。
 */
export function deriveTitle(caption: string, handle: string, createTime: Date): string {
  for (const line of caption.split(/\r?\n/)) {
    const text = line.replace(HASHTAG, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const chars = Array.from(text);
    return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("")}…` : text;
  }
  const jst = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(createTime);
  return `@${handle} ${jst}`;
}
