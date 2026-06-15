/**
 * X (Twitter) API v2 recent search — curepo (Python) からの TS 移植。
 *
 * recent search は「直近7日間」しか遡れないため、ミーグリ開催日直後の実行を前提とする。
 * search エンドポイントは X API の Basic 以上の有料プランが必要。
 *
 * 元実装: sekai-nina-project/curepo/app.py の x_search_recent / build_query 等。
 * twscrape（全期間スクレイピング）は移植しない（Python 専用・ToS リスクのため curepo に残置）。
 */

const BASE_URL = "https://api.x.com/2";

export interface HashtagGroup {
  tags: string[];
  op: "and" | "or"; // グループ内の結合
}

export interface XMediaItem {
  mediaKey: string;
  type: string; // photo | video | animated_gif
  imageUrl: string;
  width: number | null;
  height: number | null;
  altText: string;
}

export interface XTweet {
  tweetId: string;
  authorUsername: string;
  authorName: string;
  text: string;
  createdAt: string; // ISO8601（X API の created_at）
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quoteCount: number;
  url: string;
  media: XMediaItem[];
}

/** HTTP ステータスを保持したエラー。ドメイン層/アクションでユーザー向けに整形する。 */
export class XApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "XApiError";
    this.status = status;
  }
}

// recent search の 1 回の収集で辿るページ数の上限（100件/ページ）。暴走防止。
export const DEFAULT_MAX_PAGES = 10;
export const HARD_MAX_PAGES = 30;

// --- query helpers ---

function normalizeHashtags(raw: string[]): string[] {
  const tags: string[] = [];
  for (const t of raw) {
    const trimmed = t.trim().replace(/^#+/, "").trim();
    if (trimmed) tags.push("#" + trimmed);
  }
  return tags;
}

/** 1 グループ内のタグを AND(=スペース) / OR で結合。複数なら括弧で包む。 */
function buildGroup(tags: string[], op: "and" | "or"): string {
  const norm = normalizeHashtags(tags);
  if (norm.length === 0) return "";
  const joiner = op === "or" ? " OR " : " ";
  const s = norm.join(joiner);
  return norm.length > 1 ? `(${s})` : s;
}

/**
 * グループの配列を groupOp (AND/OR) で結合。例: ((#A #B) OR #C)
 *
 * AND は OR より結合が強いため、複数グループのときは全体を括弧で包み、
 * lang:ja / -is:retweet が全条件に掛かるようにする。
 */
export function buildQuery(
  groups: HashtagGroup[],
  groupOp: "and" | "or",
  excludeRetweets: boolean,
  langJa: boolean,
  extra = ""
): string {
  const groupStrs = groups
    .map((g) => buildGroup(g.tags, g.op))
    .filter((s) => s.length > 0);

  if (groupStrs.length === 0 && !extra.trim()) {
    throw new XApiError(400, "ハッシュタグまたは追加クエリを1つ以上指定してください");
  }

  const parts: string[] = [];
  if (groupStrs.length > 0) {
    const combiner = groupOp === "or" ? " OR " : " ";
    const core = groupStrs.join(combiner);
    parts.push(groupStrs.length > 1 ? `(${core})` : core);
  }
  if (extra.trim()) parts.push(extra.trim());

  let query = parts.join(" ");
  if (langJa) query += " lang:ja";
  if (excludeRetweets) query += " -is:retweet";
  return query;
}

// --- time helpers ---

/** "YYYY-MM-DD" (JST) を UTC の RFC3339 に変換。 */
export function jstDateToUtcRfc3339(dateStr: string, endOfDay: boolean): string {
  const time = endOfDay ? "23:59:59" : "00:00:00";
  // JST は UTC+9。明示オフセット付き ISO を Date に渡すと UTC に正規化される。
  const d = new Date(`${dateStr}T${time}+09:00`);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** recent search は直近7日間のみ。範囲を API が許す窓にクランプする。 */
export function clampRecentWindow(
  startRfc: string | null,
  endRfc: string | null
): { start: string | null; end: string | null } {
  const now = Date.now();
  const floor = now - 7 * 24 * 60 * 60 * 1000 + 2 * 60 * 1000; // 余裕を持たせる
  const ceil = now - 15 * 1000; // end_time は現在より十分前である必要

  let s = startRfc ? new Date(startRfc).getTime() : null;
  let e = endRfc ? new Date(endRfc).getTime() : null;
  if (s !== null && s < floor) s = floor;
  if (e !== null && e > ceil) e = ceil;

  const fmt = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { start: s !== null ? fmt(s) : null, end: e !== null ? fmt(e) : null };
}

// --- X API ---

interface XUser {
  id: string;
  username?: string;
  name?: string;
}
interface XMedia {
  media_key: string;
  type?: string;
  url?: string;
  preview_image_url?: string;
  width?: number;
  height?: number;
  alt_text?: string;
}

/**
 * recent search を maxPages 分ページングして取得。
 * 写真は url、動画/GIF は preview_image_url（サムネ）を画像として扱う。
 */
export async function xSearchRecent(
  query: string,
  startTime: string | null,
  endTime: string | null,
  maxPages: number,
  bearerToken = process.env.X_BEARER_TOKEN ?? ""
): Promise<XTweet[]> {
  if (!bearerToken) {
    throw new XApiError(500, "X_BEARER_TOKEN が未設定です (.env を確認)");
  }

  const headers = { Authorization: `Bearer ${bearerToken}` };
  const baseParams: Record<string, string> = {
    query,
    max_results: "100",
    "tweet.fields": "created_at,public_metrics,author_id,lang,attachments",
    expansions: "author_id,attachments.media_keys",
    "user.fields": "username,name",
    "media.fields": "url,preview_image_url,type,width,height,alt_text",
  };
  if (startTime) baseParams.start_time = startTime;
  if (endTime) baseParams.end_time = endTime;

  const tweets: XTweet[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  while (pages < maxPages) {
    const params = new URLSearchParams(baseParams);
    if (nextToken) params.set("next_token", nextToken);

    const resp = await fetch(`${BASE_URL}/tweets/search/recent?${params.toString()}`, {
      headers,
    });

    if (resp.status === 429) {
      const reset = Number(resp.headers.get("x-rate-limit-reset")) || Math.floor(Date.now() / 1000) + 60;
      const wait = Math.max(reset - Math.floor(Date.now() / 1000), 1);
      // 長時間待ちは避け、ここまでの取得分を返す
      if (wait > 90) break;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (resp.status === 400) {
      throw new XApiError(400, `X API がクエリを拒否しました: ${(await resp.text()).slice(0, 300)}`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new XApiError(
        resp.status,
        "X API 認証/権限エラー。Bearer Token と API プラン (search は Basic 以上) を確認してください。"
      );
    }
    if (!resp.ok) {
      throw new XApiError(resp.status, `X API エラー ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }

    const data = await resp.json();
    const includes = data.includes ?? {};
    const users = new Map<string, XUser>(
      (includes.users ?? []).map((u: XUser) => [u.id, u])
    );
    const mediaMap = new Map<string, XMedia>(
      (includes.media ?? []).map((m: XMedia) => [m.media_key, m])
    );

    for (const t of data.data ?? []) {
      const m = t.public_metrics ?? {};
      const author: XUser = users.get(t.author_id) ?? { id: t.author_id };
      const uname = author.username ?? "";
      const mediaItems: XMediaItem[] = [];
      for (const key of t.attachments?.media_keys ?? []) {
        const md = mediaMap.get(key);
        if (!md) continue;
        const img = md.url || md.preview_image_url;
        if (!img) continue;
        mediaItems.push({
          mediaKey: key,
          type: md.type ?? "",
          imageUrl: img,
          width: md.width ?? null,
          height: md.height ?? null,
          altText: md.alt_text ?? "",
        });
      }
      tweets.push({
        tweetId: t.id,
        authorUsername: uname,
        authorName: author.name ?? "",
        text: t.text ?? "",
        createdAt: t.created_at ?? "",
        likeCount: m.like_count ?? 0,
        retweetCount: m.retweet_count ?? 0,
        replyCount: m.reply_count ?? 0,
        quoteCount: m.quote_count ?? 0,
        url: uname
          ? `https://x.com/${uname}/status/${t.id}`
          : `https://x.com/i/status/${t.id}`,
        media: mediaItems,
      });
    }

    pages += 1;
    nextToken = data.meta?.next_token;
    if (!nextToken) break;
  }

  return tweets;
}

/** 写真の高解像度を要求する URL を返す（curepo の name=large 付与）。 */
export function highResImageUrl(item: XMediaItem): string {
  let url = item.imageUrl;
  if (item.type === "photo" && !url.includes("name=")) {
    url += (url.includes("?") ? "&" : "?") + "name=large";
  }
  return url;
}
