import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * 外から渡された URL をサーバーが取りに行くための fetch (SSRF 対策つき)。
 *
 * MCP のツール引数は LLM が組むので、プロンプトインジェクション 1 回で
 * `http://169.254.169.254/` (クラウドのメタデータ) や社内ホストを叩かせられる。そこで:
 * - https だけを通す
 * - 名前解決した結果が 1 つでも内部向けのアドレスなら拒否する
 * - 接続はその検査を通した IP に張る (`lookup` を差し替えるので、検査後に DNS が変わっても効く)
 * - リダイレクトは自前で追い、毎回同じ検査を通す
 * - 本文は上限バイト数で打ち切る
 */

/** グローバルに到達できないアドレス帯 (IANA の special-purpose registry をもとに) */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // リンクローカル (クラウドのメタデータ)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // マルチキャスト
  ["240.0.0.0", 4], // 予約 + ブロードキャスト
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96], // 未指定・ループバック・IPv4 互換 (::7f00:1)
  ["64:ff9b::", 96], // NAT64 (中に v4 を埋められる)
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4 (中に v4 を埋められる)
  ["fc00::", 7], // ユニークローカル
  ["fe80::", 10], // リンクローカル
  ["fec0::", 10],
  ["ff00::", 8], // マルチキャスト
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

/** IPv4 射影アドレス (`::ffff:10.0.0.1`) を v4 に戻す。それ以外はそのまま */
function unmapIpv4(address: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return m ? m[1] : address;
}

/** そのアドレスに接続してよいか (グローバルなユニキャストか) */
export function isPublicAddress(address: string): boolean {
  const addr = unmapIpv4(address);
  const family = isIP(addr);
  if (family === 4) return !BLOCKED.check(addr, "ipv4");
  if (family === 6) {
    // IPv4 射影 (::ffff:0:0/96) は BlockList に入れない。入れると v4 の検査まで全部ひっかかる
    // (BlockList は v4 を射影アドレスとしても照合する)。16 進表記の ::ffff:7f00:1 もここで落とす
    if (/^::ffff:/i.test(addr)) return false;
    return !BLOCKED.check(addr, "ipv6");
  }
  return false;
}

export class SafeFetchError extends Error {}

/** 解決したアドレスが 1 つでも内部向けなら失敗させる lookup */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, "", 0);
    const blocked = addresses.find((a) => !isPublicAddress(a.address));
    if (blocked || addresses.length === 0) {
      // ホスト名は返さない (どの名前が内部に解決されるかを探る手がかりにさせない)
      return callback(new SafeFetchError("内部向けのアドレスには接続できません"), "", 0);
    }
    // Node 20+ の autoSelectFamily は all: true で呼んでくる
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

/**
 * safeLookup 専用の Agent。グローバルの keep-alive プールは lookup を区別しないので、
 * 別の経路が検査なしで張ったソケットを使い回さないように分ける
 */
const safeAgent = new https.Agent({ lookup: safeLookup, keepAlive: false });

/** 既定のリダイレクト上限 */
const DEFAULT_MAX_REDIRECTS = 5;

const NETWORK_ERROR_MESSAGES: Record<string, string> = {
  ENOTFOUND: "ホスト名を解決できません",
  EAI_AGAIN: "ホスト名を解決できません",
  ECONNREFUSED: "接続を拒否されました",
  ECONNRESET: "接続が切れました",
  ETIMEDOUT: "タイムアウトしました",
  CERT_HAS_EXPIRED: "TLS 証明書の期限が切れています",
  DEPTH_ZERO_SELF_SIGNED_CERT: "TLS 証明書を検証できません",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS 証明書を検証できません",
  ERR_TLS_CERT_ALTNAME_INVALID: "TLS 証明書のホスト名が一致しません",
  ERR_INVALID_CHAR: "リクエストヘッダーに使えない文字があります",
};

/** 接続まわりのエラーを、呼び出し側が理由を返せる SafeFetchError に寄せる */
function toSafeFetchError(err: unknown): unknown {
  if (err instanceof SafeFetchError) return err;
  const code = (err as { code?: string } | null)?.code;
  if (code && NETWORK_ERROR_MESSAGES[code]) return new SafeFetchError(NETWORK_ERROR_MESSAGES[code]);
  if (code) return new SafeFetchError(`接続に失敗しました (${code})`);
  return err;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/** URL として取りに行ってよい形か。だめなら理由を返す */
export function checkFetchableUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "URL として解釈できません" };
  }
  if (url.protocol !== "https:") return { error: "https の URL だけ取得できます" };
  if (url.username || url.password) return { error: "認証情報つきの URL は取得できません" };
  if (url.port && url.port !== "443") return { error: "443 以外のポートは取得できません" };
  // IP 直書きは lookup を通らないので、ここで見る
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) return { error: "内部向けのアドレスには接続できません" };
  return { url };
}

export interface SafeFetchResult {
  /** リダイレクトを追った後の URL */
  finalUrl: string;
  contentType: string;
  body: Buffer;
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
}

function requestOnce(url: URL, opts: SafeFetchOptions) {
  return new Promise<
    | { kind: "redirect"; location: string }
    | { kind: "ok"; contentType: string; body: Buffer }
  >((resolve, reject) => {
    const req = https.get(
      url,
      { agent: safeAgent, headers: opts.headers, timeout: opts.timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          // 本文は読まない (無限に送ってくる相手に付き合わない)
          res.destroy();
          return resolve({ kind: "redirect", location: res.headers.location });
        }
        if (status < 200 || status >= 300) {
          res.destroy();
          return reject(new SafeFetchError(`HTTP ${status}`));
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          res.destroy();
          return reject(new SafeFetchError(`${formatBytes(opts.maxBytes)} を超えています`));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > opts.maxBytes) {
            res.destroy();
            req.destroy();
            return reject(new SafeFetchError(`${formatBytes(opts.maxBytes)} を超えています`));
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            kind: "ok",
            contentType: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks),
          })
        );
        res.on("error", reject);
      }
    );
    // timeout は無通信の時間。少しずつ送ってくる相手は、全体の上限 (timer) で切る
    const timer = setTimeout(
      () => req.destroy(new SafeFetchError("タイムアウトしました")),
      opts.timeoutMs
    );
    req.on("timeout", () => req.destroy(new SafeFetchError("タイムアウトしました")));
    req.on("error", reject);
    req.on("close", () => clearTimeout(timer));
  });
}

/**
 * https の公開 URL を取得する。内部向けアドレス・上限超え・リダイレクトの回数超えは
 * `SafeFetchError` を投げる。
 */
export async function safeFetch(raw: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const deadline = Date.now() + opts.timeoutMs;
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const checked = checkFetchableUrl(current);
    if ("error" in checked) throw new SafeFetchError(checked.error);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SafeFetchError("タイムアウトしました");

    const res = await requestOnce(checked.url, { ...opts, timeoutMs: remaining }).catch((err) => {
      throw toSafeFetchError(err);
    });
    if (res.kind === "ok") {
      return { finalUrl: checked.url.toString(), contentType: res.contentType, body: res.body };
    }
    try {
      current = new URL(res.location, checked.url).toString();
    } catch {
      throw new SafeFetchError("リダイレクト先が URL として解釈できません");
    }
  }
  throw new SafeFetchError("リダイレクトが多すぎます");
}
