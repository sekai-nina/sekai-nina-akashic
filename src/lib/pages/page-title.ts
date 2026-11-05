import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { decodeEntities, metaContent } from "@/lib/places/google-maps-preview";

/**
 * リンク先のページのタイトルを取る (物の記事の購入リンクのカードの題)。
 *
 * X や Amazon はふつうのブラウザには中身の無いページや確認画面を返し、SNS のリンクプレビュー用の
 * ボットにだけ `og:title` / `<title>` を返す。そのため User-Agent はボットのものを名乗る。
 *
 * URL は企画に人が入れたものなので、サーバーの内側 (ループバック・プライベートアドレス) には
 * 取りに行かない。リダイレクトも 1 回ごとに見直す。取れなければ null で、呼び出し側は題を空のままにする
 */

const BOT_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
/** 1 つのリンクにかける時間の上限。記事の組み立ての待ち時間をこれ以上延ばさない */
const TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
/** 読む量の上限 (`<head>` の中だけ要る。大きなページで止まらないように) */
const MAX_BYTES = 1_000_000;
const MAX_TITLE_LENGTH = 120;
/** ボット避けやエラーのページの題。これらを記事に載せない */
const USELESS_TITLE = /^(just a moment|attention required|access denied|forbidden|not found|error\b|403\b|404\b)/i;

/** 取りに行かないアドレスか (ループバック・プライベート・リンクローカルなど) */
export function isBlockedAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

async function isPublicHost(url: URL): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) > 0) return !isBlockedAddress(host);
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every((a) => !isBlockedAddress(a.address));
  } catch {
    return false;
  }
}

/** ページの HTML からタイトルを取り出す。純粋関数 */
export function extractTitle(html: string): string | null {
  // 本文の SVG の `<title>` を拾わないように `<head>` の中だけ見る
  const head = html.split(/<\/head>/i)[0];
  const raw = metaContent(head, "og:title") ?? head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const title = raw ? decodeEntities(raw).replace(/\s+/g, " ").trim() : "";
  if (!title || USELESS_TITLE.test(title)) return null;
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH)}…` : title;
}

async function readHead(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks);
}

/** 文字コードは Content-Type、無ければ `<meta charset>` で見る (日本のお店は Shift_JIS がある) */
export function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const ascii = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const charset = (contentType.match(/charset=["']?([\w-]+)/i) ?? ascii.match(/<meta[^>]+charset=["']?([\w-]+)/i))?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export async function fetchPageTitle(rawUrl: string): Promise<string | null> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    let url = new URL(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await isPublicHost(url))) return null;
      const res = await fetch(url, { headers: { "User-Agent": BOT_UA, Accept: "text/html" }, redirect: "manual", signal });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      if (!res.ok) return null;
      const contentType = res.headers.get("content-type") ?? "";
      if (!/html/i.test(contentType)) return null;
      return extractTitle(decodeHtml(await readHead(res), contentType));
    }
    return null;
  } catch {
    return null;
  }
}
