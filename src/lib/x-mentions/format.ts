import type { XMentionHit } from "@prisma/client";
import { formatDate } from "@/lib/utils";

/**
 * Discord に流すメッセージの整形 (純関数)。
 * run.ts から分けてあるのは、テストが `@/lib/db` (PrismaClient の生成 = 接続文字列が要る) を
 * 引き込まずに済むようにするため。CI には DATABASE_URL が無い
 */

/** 本文をメッセージに載せる長さ (Discord がリンクを展開するので全文は要らない) */
const TEXT_MAX_CHARS = 280;

/**
 * 1 ヒットぶんのメッセージ。URL は裸で置いて Discord にツイートを展開させる。
 * 本文は長ければ切る (展開で全文が見える)。`allowed_mentions` は空なので @ が鳴ることはない
 */
export function formatHitMessage(
  hit: Pick<XMentionHit, "authorUsername" | "authorName" | "text" | "tweetedAt" | "url">,
  queries: string[]
): string {
  const who = hit.authorName ? `${hit.authorName} (@${hit.authorUsername})` : `@${hit.authorUsername}`;
  const when = hit.tweetedAt ? formatDate(hit.tweetedAt, true) : "";
  const text = hit.text.replace(/\s+/g, " ").trim();
  const body = text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}…` : text;
  return [`🔎 **${queries.join(" / ")}** — ${who}${when ? `　${when}` : ""}`, `> ${body}`, hit.url].join("\n");
}
