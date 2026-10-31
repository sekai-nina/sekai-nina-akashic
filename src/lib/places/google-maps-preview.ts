import { isAllowedMapsUrl } from "@/lib/places/resolve-google-maps-url";

/**
 * Google マップのリンクから、Discord や X にリンクを貼ったときに出るプレビューと同じもの
 * (お店の写真と住所) を取る。聖地のカード (```cardlink) に `image:` / `description:` として書く。
 *
 * Google はふつうのブラウザには写真の無いページを返し、SNS のリンクプレビュー用のボットにだけ
 * `og:image` (lh3.googleusercontent.com の写真) と `og:title` (「名前 · 〒… 住所」) を返す。
 * そのため User-Agent はボットのものを名乗る。
 *
 * 写真の URL は取るたびに変わりうるので、プレビューと保存を指紋で突き合わせる記事生成の途中には混ぜない。
 * **DB に書く直前** (`addCardPreviews`) にだけ足す。取れなければカードは座標の地図サムネイルのまま
 */

export interface GoogleMapsPreview {
  /** お店の写真 (googleusercontent.com の https)。無ければ null */
  image: string | null;
  /** 「〒… 住所」。無ければ null */
  address: string | null;
}

const BOT_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const TIMEOUT_MS = 8_000;

function metaContent(html: string, property: string): string | null {
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0];
    if (!new RegExp(`(?:property|itemprop)="${property}"`).test(tag)) continue;
    const c = tag.match(/content="([^"]*)"/);
    if (c) return decodeEntities(c[1]);
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 写真として使う URL か。Google の静的地図 (API キー入りの staticmap) や他所の URL は使わない */
function isPhotoUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /(^|\.)googleusercontent\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * カードの画像枠 (160×100) の 2 倍に縮めた写真を頼む (900×900 だと 1 枚 160KB ある)。
 * 縮められるのは末尾が `=w900-h900-p-k-no` の形のものだけ (ストリートビューの写真は大きさを変えると 403)
 */
function thumbnailUrl(url: string): string {
  return url.replace(/=w\d+-h\d+-p-k-no$/, "=w320-h200-p-k-no");
}

/** ボット向けページの HTML から写真と住所を抜く (純粋) */
export function parseGoogleMapsPreview(html: string): GoogleMapsPreview {
  const img = metaContent(html, "og:image");
  const title = metaContent(html, "og:title");
  // 「リズラボキッチン · 〒150-0001 東京都渋谷区…」の · より後ろ。· が無いもの (「Google マップ」) は住所なし
  const sep = title?.indexOf(" · ") ?? -1;
  const address = title && sep >= 0 ? title.slice(sep + 3).trim() : "";
  return {
    image: img && isPhotoUrl(img) ? thumbnailUrl(img) : null,
    address: address || null,
  };
}

/**
 * Google マップのリンクのプレビューを取る。Google 以外のホストへは (リダイレクト先も含めて) 行かない。
 * 失敗したら null (カードはそのまま)
 */
export async function fetchGoogleMapsPreview(url: string): Promise<GoogleMapsPreview | null> {
  let current = url;
  try {
    for (let hop = 0; hop < 5; hop++) {
      if (!isAllowedMapsUrl(new URL(current))) return null;
      const res = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": BOT_UA, "Accept-Language": "ja" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const next = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && next) {
        current = new URL(next, current).toString();
        continue;
      }
      if (!res.ok) return null;
      const preview = parseGoogleMapsPreview(await res.text());
      // ストリートビューの写真 (gpms-cs-s) などは og:image に載っていても外から読むと 403 になる。
      // 壊れた画像のカードにしないよう、読めることを確かめてから使う (読めなければ地図サムネイルに回る)
      if (preview.image && !(await isLoadableImage(preview.image))) preview.image = null;
      return preview;
    }
  } catch {
    // タイムアウト・壊れた URL など。写真なしのカードのままにする
  }
  return null;
}

async function isLoadableImage(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel();
    return res.ok && (res.headers.get("content-type") ?? "").startsWith("image/");
  } catch {
    return false;
  }
}

const CARD = /^```cardlink\n((?:(?!```)[^\n]*\n)*?)```$/gm;

/**
 * 本文の Google マップのカードのうち、写真 (`image:`) の無いものに写真と住所 (`description:`) を足す。
 * 取れたものだけ足し、ほかの行・カード以外の本文は触らない。`fetchPreview` はテストで差し替える
 */
export async function addCardPreviews(
  body: string,
  fetchPreview: (url: string) => Promise<GoogleMapsPreview | null> = fetchGoogleMapsPreview,
): Promise<{ body: string; added: number }> {
  const targets = new Set<string>();
  for (const m of body.matchAll(CARD)) {
    const url = m[1].match(/^url:\s*(\S+)/m)?.[1];
    if (!url || /^image:/m.test(m[1])) continue;
    try {
      if (isAllowedMapsUrl(new URL(url))) targets.add(url);
    } catch {
      // 壊れた URL のカードは触らない
    }
  }
  if (targets.size === 0) return { body, added: 0 };

  const previews = new Map<string, GoogleMapsPreview | null>();
  await Promise.all([...targets].map(async (u) => previews.set(u, await fetchPreview(u))));

  let added = 0;
  const out = body.replace(CARD, (whole, inner: string) => {
    const url = inner.match(/^url:\s*(\S+)/m)?.[1];
    const p = url ? previews.get(url) : null;
    if (!p?.image || /^image:/m.test(inner)) return whole;
    const lines = [`image: ${p.image}`];
    if (p.address && !/^description:/m.test(inner)) lines.push(`description: "${p.address.replace(/"/g, "'")}"`);
    added++;
    return `\`\`\`cardlink\n${inner}${lines.join("\n")}\n\`\`\``;
  });
  return { body: out, added };
}
