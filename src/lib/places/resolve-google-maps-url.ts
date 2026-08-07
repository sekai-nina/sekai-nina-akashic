/**
 * Google Maps の URL から緯度経度・地点名を取り出す。
 *
 * REST (`GET /api/v1/places/resolve-url`) と MCP (`akashic_create_place`) の
 * 両方から使う。短縮 URL の展開は SHORT_HOSTS に載っているホストに対してのみ行う
 * (= 任意の URL を fetch させない)。
 */

const SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl", "g.co"]);

/** google.com / maps.google.co.jp などにマッチする (evil-google.com や google.com.evil.com は弾く) */
const GOOGLE_HOST = /^(?:[a-z0-9-]+\.)*google\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

/**
 * 座標の抽出を許可するホストか。
 *
 * 戻り値の URL は Place.googleMapsUrl に保存され、画面で `<a href>` として描画される。
 * MCP 経由では URL の出所が LLM (= 外部入力) になるので、Google 以外のホストや
 * javascript: / data: スキームを弾かないとフィッシング・XSS の入口になる。
 */
function isAllowedMapsUrl(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return SHORT_HOSTS.has(host) || GOOGLE_HOST.test(host);
}

export interface ResolvedGoogleMapsUrl {
  lat: number;
  lng: number;
  /** URL から取れた地点名。取れなければ空文字 */
  name: string;
  /** 短縮 URL を展開した後の URL (展開しなかった場合は入力そのまま) */
  googleMapsUrl: string;
}

export type ResolveGoogleMapsUrlError =
  | "invalid_url"
  | "unsupported_host"
  | "no_coordinates";

export interface ResolveGoogleMapsUrlFailure {
  ok: false;
  error: ResolveGoogleMapsUrlError;
  /** no_coordinates / unsupported_host のとき、展開まではできた URL */
  expanded?: string;
}

export type ResolveGoogleMapsUrlResult =
  | ({ ok: true } & ResolvedGoogleMapsUrl)
  | ResolveGoogleMapsUrlFailure;

function extractLatLng(url: string): { lat: number; lng: number } | null {
  // Pattern: !3d{lat}!4d{lng} (Google Maps share URLs)
  const m1 = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]) };
  // Pattern: @{lat},{lng}, (place URLs)
  const m2 = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
  // Pattern: ?q={lat},{lng}
  const m3 = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m3) return { lat: parseFloat(m3[1]), lng: parseFloat(m3[2]) };
  // Pattern: ?ll={lat},{lng}
  const m4 = url.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m4) return { lat: parseFloat(m4[1]), lng: parseFloat(m4[2]) };
  return null;
}

function extractName(url: string): string | null {
  // /place/{name}/@... — name is URL-encoded
  const m = url.match(/\/place\/([^/@]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]).replace(/\+/g, " ");
    } catch {
      return null;
    }
  }
  return null;
}

async function expandShortUrl(input: string): Promise<string> {
  let current = input;
  for (let i = 0; i < 5; i++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return current;
    }
    if (!SHORT_HOSTS.has(parsed.hostname)) return current;
    // Don't follow automatically — we want to capture the Location header
    const res = await fetch(current, { method: "GET", redirect: "manual" });
    const next = res.headers.get("location");
    if (!next) return current;
    current = next.startsWith("http") ? next : new URL(next, current).toString();
  }
  return current;
}

export async function resolveGoogleMapsUrl(
  raw: string
): Promise<ResolveGoogleMapsUrlResult> {
  const input = raw.trim();

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: "invalid_url" };
  }

  if (!isAllowedMapsUrl(parsed)) {
    return { ok: false, error: "unsupported_host" };
  }

  // フル形式の Maps URL ならこの時点で取れる
  let coords = extractLatLng(input);
  let expanded = input;
  let name = extractName(input);

  // 短縮 URL、または座標が取れなかった場合はリダイレクトを追って正規 URL を得る
  if (SHORT_HOSTS.has(parsed.hostname) || !coords) {
    try {
      expanded = await expandShortUrl(input);
      if (!coords) coords = extractLatLng(expanded);
      if (!name) name = extractName(expanded);
    } catch {
      // 展開に失敗しても、取れているぶんで判定を続ける
    }
  }

  // 展開後の URL も検証する。短縮 URL のリダイレクト先は任意のホストになりうるので、
  // 保存・描画される値としてはここが最後の関門になる。
  if (expanded !== input) {
    let expandedUrl: URL;
    try {
      expandedUrl = new URL(expanded);
    } catch {
      return { ok: false, error: "unsupported_host", expanded };
    }
    if (!isAllowedMapsUrl(expandedUrl)) {
      return { ok: false, error: "unsupported_host", expanded };
    }
  }

  if (!coords) {
    return { ok: false, error: "no_coordinates", expanded };
  }

  return {
    ok: true,
    lat: coords.lat,
    lng: coords.lng,
    name: name ?? "",
    googleMapsUrl: expanded,
  };
}
