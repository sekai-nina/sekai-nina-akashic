/**
 * Sony Music のディスコグラフィ JSON の取得 (#167)。
 *
 * 公式サイト (hinatazaka46.com) の disco.detail*.js が同じ URL を JSONP で読んでいる。
 * 認証は無いが、ブラウザ以外の UA / Referer 無しだと 404 の HTML が返るので付ける。
 * 詳細は 1 盤 1 リクエスト (144 件で 1 分弱)。
 */

import { parseJsonp, type CatalogDetail, type CatalogItem } from "./catalog";

const BASE = "https://www.sonymusic.co.jp/json/v2/artist";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Referer: "https://www.sonymusic.co.jp/",
};

async function getJsonp<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  // 404 でも HTML が 200 相当で返ることがあるので、JSONP の形かどうかも見る
  const looksJsonp = /^\s*\w+\(/.test(text) && /\)\s*;?\s*$/.test(text);
  if (!res.ok || !looksJsonp) {
    throw new Error(`Sony Music の JSON が取れません (${res.status}): ${url}`);
  }
  return parseJsonp<T>(text);
}

/** 一覧を全ページ読む */
export async function fetchCatalog(artist: string): Promise<CatalogItem[]> {
  const items: CatalogItem[] = [];
  const count = 100;
  for (let start = 0; ; start += count) {
    const page = await getJsonp<{ items: CatalogItem[]; total_count: number }>(
      `${BASE}/${artist}/discography/start/${start}/count/${count}/callback/disco_index`
    );
    items.push(...page.items);
    if (page.items.length < count || items.length >= page.total_count) break;
  }
  return items;
}

/** 盤の詳細 (収録曲つき) */
export async function fetchDetail(artist: string, code: string): Promise<CatalogDetail> {
  const cb = code.replace(/-/g, "").toLowerCase();
  const res = await getJsonp<{ items: CatalogDetail }>(`${BASE}/${artist}/discography/${code}/callback/${cb}`);
  return res.items;
}
