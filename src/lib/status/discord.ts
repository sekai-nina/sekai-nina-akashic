import type { StatusLevel } from "@prisma/client";
import { STATUS_LEVEL_LABELS } from "@/lib/utils";

/**
 * Discord の Incoming Webhook に状態の変化を投げる。素の `fetch` (SDK は入れない)。
 * URL は `DISCORD_STATUS_WEBHOOK_URL`。未設定なら何もしない (ローカルで cron を叩いても静か)。
 */

export function isDiscordConfigured(): boolean {
  return !!process.env.DISCORD_STATUS_WEBHOOK_URL?.trim();
}

/** 通知に載せる 1 行。/status の並びと同じ情報だけ (本文は載せない) */
export interface NotificationLine {
  name: string;
  status: StatusLevel;
  prevStatus: StatusLevel | null;
  summary: string;
  kind: "transition" | "reminder";
}

const LEVEL_ICON: Record<StatusLevel, string> = {
  ok: "🟢",
  warn: "🟠",
  error: "🔴",
  unknown: "⚪",
};

/** アプリの URL。cron はリクエストの host が Vercel の内部名になるので AUTH_URL を使う */
function statusPageUrl(): string {
  const base = process.env.AUTH_URL?.trim().replace(/\/$/, "");
  return base ? `${base}/status` : "/status";
}

/** Discord の content 上限 (2000) に収める。行単位で切って URL の行は必ず残す */
const CONTENT_MAX_CHARS = 1900;
/** 429 のとき待つ幅。retry_after (秒) をこの範囲に収める */
const RETRY_WAIT_MIN_MS = 500;
const RETRY_WAIT_MAX_MS = 10_000;

export function formatNotification(lines: NotificationLine[], link: string = statusPageUrl()): string {
  const body = lines.map((l) => {
    const head = `${LEVEL_ICON[l.status]} **${l.name}**`;
    const change =
      l.kind === "reminder"
        ? `${STATUS_LEVEL_LABELS[l.status]} が続いています`
        : l.prevStatus
          ? `${STATUS_LEVEL_LABELS[l.prevStatus]} → ${STATUS_LEVEL_LABELS[l.status]}`
          : STATUS_LEVEL_LABELS[l.status];
    return `${head} — ${change}\n　${l.summary}`;
  });
  const budget = CONTENT_MAX_CHARS - link.length - 1;
  const kept: string[] = [];
  let used = 0;
  for (const b of body) {
    if (used + b.length + 1 > budget) {
      kept.push(`…他 ${body.length - kept.length} 件`);
      break;
    }
    kept.push(b);
    used += b.length + 1;
  }
  return [...kept, link].join("\n");
}

/**
 * 1 メッセージを送る。content が上限を超えていたら切る (formatNotification を通していれば超えない)。
 * 失敗は例外にする (呼び出し側が lastNotifiedAt を進めないため)。
 */
export async function postDiscord(content: string): Promise<void> {
  const url = process.env.DISCORD_STATUS_WEBHOOK_URL?.trim();
  if (!url) return;
  await postDiscordWebhook(url, content);
}

/**
 * 任意の Incoming Webhook に 1 メッセージを送る (/status 以外の通知先もここを通す)。
 * メンションは一切鳴らさない。429 は Discord が返す retry_after だけ待って 1 回だけやり直す
 * (webhook は 1 本あたり 2 秒に 5 件までで、続けて送るとすぐ当たる)。
 */
export async function postDiscordWebhook(url: string, content: string): Promise<void> {
  const trimmed = trimContent(content);
  await sendWithRetry(() =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: trimmed, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(10_000),
    }),
  );
}

export interface DiscordAttachment {
  filename: string;
  data: Buffer;
  /** 必ず付ける。無いと Discord が動画をただのファイルとして出し、その場で再生できない */
  contentType: string;
}

/**
 * 本文 + 添付を 1 メッセージで送る (multipart/form-data)。添付の件数・サイズは呼び出し側が
 * Discord の上限 (10 件・無料枠 8MiB) に収めておく。添付が空なら `postDiscordWebhook` と同じ。
 */
export async function postDiscordWebhookWithFiles(
  url: string,
  content: string,
  files: DiscordAttachment[],
): Promise<void> {
  if (files.length === 0) return postDiscordWebhook(url, content);
  const trimmed = trimContent(content);
  const build = () => {
    const form = new FormData();
    form.append(
      "payload_json",
      JSON.stringify({
        content: trimmed,
        allowed_mentions: { parse: [] },
        attachments: files.map((f, i) => ({ id: i, filename: f.filename })),
      }),
    );
    files.forEach((f, i) => {
      // Buffer をコピーせず view のまま Blob にする (10 × 8MiB を 2 重に持たない)。
      // Node の Buffer は ArrayBufferLike を指すので、BlobPart に合わせて型だけ絞る
      const view = new Uint8Array(f.data.buffer as ArrayBuffer, f.data.byteOffset, f.data.byteLength);
      form.append(`files[${i}]`, new Blob([view], { type: f.contentType }), f.filename);
    });
    return form;
  };
  // FormData は 1 回しか送れないので、再送のたびに組み直す (数十 MB でも一瞬)
  await sendWithRetry(() => fetch(url, { method: "POST", body: build(), signal: AbortSignal.timeout(60_000) }));
}

function trimContent(content: string): string {
  return content.length > CONTENT_MAX_CHARS ? `${content.slice(0, CONTENT_MAX_CHARS)}\n…` : content;
}

async function sendWithRetry(send: () => Promise<Response>): Promise<void> {
  let res = await send();
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
    const waitMs = Math.min(Math.max((body.retry_after ?? 1) * 1000, RETRY_WAIT_MIN_MS), RETRY_WAIT_MAX_MS);
    await new Promise((r) => setTimeout(r, waitMs));
    res = await send();
  }
  if (!res.ok) throw new Error(`Discord webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
