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
  const trimmed = content.length > CONTENT_MAX_CHARS ? `${content.slice(0, CONTENT_MAX_CHARS)}\n…` : content;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: trimmed, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Discord webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
