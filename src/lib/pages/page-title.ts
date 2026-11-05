import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { decodeEntities } from "@/lib/places/google-maps-preview";

/**
 * リンク先のページのタイトルを取る (物の記事の購入リンクのカードの題)。
 *
 * X や Amazon はふつうのブラウザには中身の無いページや確認画面を返し、SNS のリンクプレビュー用の
 * ボットにだけ `og:title` / `<title>` を返す。そのため User-Agent はボットのものを名乗る。
 *
 * URL は企画に人が入れたものなので、サーバーの内側 (ループバック・プライベートアドレス) には
 * 取りに行かない。リダイレクトも 1 回ごとに見直す。取れなければ null で、呼び出し側は題を空のままにする。
 * 名前解決の結果を確かめたあとに `fetch` が解決し直すので、DNS を切り替えられると防げない
 * (入力できるのは企画の編集権限を持つ人だけで、持ち出せるのも HTML のタイトルだけなので許容している)
 */

const BOT_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
/** 1 つのリンクにかける時間の上限。記事の組み立ての待ち時間をこれ以上延ばさない */
const TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
/** 読む量の上限 (`<head>` の中だけ要る。大きなページで止まらないように) */
const MAX_BYTES = 1_000_000;
const MAX_TITLE_LENGTH = 120;
/** ボット避けやエラーのページの題。これらを記事に載せない */
const USELESS_TITLE = /^(just a moment|attention required|access denied|robot check|forbidden|not found|error\b|403\b|404\b|ページが見つかりません|お探しのページ)/i;

/** 取りに行かないアドレス。`BlockList` は `::ffff:7f00:1` のような IPv4 射影の IPv6 も IPv4 の規則で見る */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96], // 未指定・ループバック・IPv4 互換
  ["64:ff9b::", 96], // NAT64
  ["2002::", 16], // 6to4
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true;
  return BLOCKED.check(ip, family === 4 ? "ipv4" : "ipv6");
}

async function isPublicHost(url: URL, signal: AbortSignal): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) > 0) return !isBlockedAddress(host);
  try {
    // `lookup` は中断できないので、詰まっても時間の上限で抜ける
    const addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    ]);
    return addresses.length > 0 && addresses.every((a) => !isBlockedAddress(a.address));
  } catch {
    return false;
  }
}

/** `<meta>` の中の og:title。`>` の無い入力でも線形で終わるよう、正規表現で全体を走査しない */
function ogTitle(head: string): string | null {
  const lower = head.toLowerCase();
  for (let at = lower.indexOf("<meta"); at >= 0; at = lower.indexOf("<meta", at + 5)) {
    const end = lower.indexOf(">", at);
    if (end < 0) return null;
    const tag = head.slice(at, end);
    if (!/(?:property|name)\s*=\s*["']?og:title["'\s/]/i.test(`${tag} `)) continue;
    const content = tag.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (content) return content[1] ?? content[2];
  }
  return null;
}

function titleTag(head: string): string | null {
  const lower = head.toLowerCase();
  const at = lower.indexOf("<title");
  const open = at < 0 ? -1 : lower.indexOf(">", at);
  const close = open < 0 ? -1 : lower.indexOf("</title", open);
  return close < 0 ? null : head.slice(open + 1, close);
}

/** ページの HTML からタイトルを取り出す。純粋関数 */
export function extractTitle(html: string): string | null {
  // 本文の SVG の `<title>` を拾わないように `<head>` の中だけ見る (`</head>` は省略できるので `<body` でも切る)
  const lower = html.toLowerCase();
  const ends = [lower.indexOf("</head"), lower.indexOf("<body")].filter((i) => i >= 0);
  const head = ends.length > 0 ? html.slice(0, Math.min(...ends)) : html;
  const raw = ogTitle(head) ?? titleTag(head);
  if (!raw) return null;
  // DB (NUL) と公開の本文に載せられない文字を落とす。`\uFFFD` は文字コードを読み違えた印なので題にしない
  const title = decodeEntities(raw)
    .toWellFormed()
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title || title.includes("\uFFFD") || USELESS_TITLE.test(title)) return null;
  const chars = [...title];
  return chars.length > MAX_TITLE_LENGTH ? `${chars.slice(0, MAX_TITLE_LENGTH).join("")}…` : title;
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
      if (!(await isPublicHost(url, signal))) return null;
      const res = await fetch(url, { headers: { "User-Agent": BOT_UA, Accept: "text/html" }, redirect: "manual", signal });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || !/html/i.test(contentType)) {
        await res.body?.cancel();
        return null;
      }
      return extractTitle(decodeHtml(await readHead(res), contentType));
    }
    return null;
  } catch {
    return null;
  }
}
