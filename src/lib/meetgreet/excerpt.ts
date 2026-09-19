/**
 * 「本人の感想」の抜粋提案 (#108)。
 *
 * ドシエに入れたブログ本文から、そのミーグリについて書いている範囲を LLM に選ばせ、
 * `DossierItem` の抜粋 (excerptStart / excerptEnd) の候補として返す。
 *
 * **公開サイトの引用になる文面なので、提案をそのまま採用はしない。** 画面でチェックして
 * ドシエに入れ、細かい範囲は既存の範囲選択 UI で直す前提。
 *
 * 位置の確定 (`locateExcerpt`) は DB に触らない純粋関数なのでテストがある。
 */

const OPENAI_MODEL = "gpt-4.1";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/** 1 本のブログから提案する抜粋の上限 */
export const MAX_EXCERPTS_PER_BLOG = 4;

const SYSTEM_PROMPT = `あなたは日向坂46・坂井新奈のファンサイトの編集者です。
本人のブログ本文から、指定された日のミート＆グリート（ミーグリ / お話し会）について
書いている部分だけを抜き出します。

抜き出す対象:
- その日のミーグリの感想・お礼・振り返り
- その日の衣装や髪型についての言及（「浴衣でした」など、ミーグリの話と地続きのもの）
- ミーグリでのファンとのやりとりの描写

抜き出さないもの:
- 別の日の出来事、別の仕事や予定の話
- 事務連絡・告知だけの部分
- 挨拶だけの定型文（「こんにちは！」等）

重要:
- **必ず原文のままの連続した部分文字列を返してください。** 要約・言い換え・句読点の追加をしないでください
- 離れた場所に複数ある場合は、それぞれを別の要素として返してください（間を「…」で繋がない）
- 段落の途中で切らず、文の切れ目で始めて文の切れ目で終わらせてください
- 該当する部分が無ければ空の配列を返してください`;

const RESPONSE_SCHEMA = {
  name: "meetgreet_excerpts",
  strict: true,
  schema: {
    type: "object",
    properties: {
      excerpts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "原文のままの連続した部分文字列。要約や言い換えをしない",
            },
            reason: {
              type: "string",
              description: "なぜこの範囲がそのミーグリの話だと判断したか。30文字以内",
            },
          },
          required: ["text", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["excerpts"],
    additionalProperties: false,
  },
};

export interface ExcerptProposal {
  text: string;
  reason: string;
  start: number;
  end: number;
}

/** 改行・空白の揺れを吸収するため、比較用に空白を 1 つに潰す */
function normalize(s: string): { text: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let lastWasSpace = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const isSpace = /\s/.test(c);
    if (isSpace) {
      if (lastWasSpace) continue;
      chars.push(" ");
      map.push(i);
      lastWasSpace = true;
    } else {
      chars.push(c);
      map.push(i);
      lastWasSpace = false;
    }
  }
  return { text: chars.join(""), map };
}

/**
 * 本文の中から抜粋の位置を探す。
 *
 * LLM は原文どおりに返してくるとは限らない（改行が空白になる、前後の空白が落ちる等）ので、
 * まず素で探し、だめなら空白を潰した文字列どうしで探して元の位置に戻す。
 * 見つからなければ null（= 採用しない。ズレた範囲を引用するより出さないほうがよい）。
 */
export function locateExcerpt(content: string, quote: string): { start: number; end: number } | null {
  const trimmed = quote.trim();
  if (!trimmed) return null;

  const direct = content.indexOf(trimmed);
  if (direct >= 0) return { start: direct, end: direct + trimmed.length };

  const haystack = normalize(content);
  const needle = normalize(trimmed);
  if (!needle.text) return null;
  const at = haystack.text.indexOf(needle.text);
  if (at < 0) return null;

  const start = haystack.map[at];
  const lastIdx = at + needle.text.length - 1;
  const end = haystack.map[lastIdx] + 1;
  return { start, end };
}

/** 重なり合う提案を落とす（先に出たものを優先） */
export function dropOverlapping(items: ExcerptProposal[]): ExcerptProposal[] {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const kept: ExcerptProposal[] = [];
  for (const it of sorted) {
    if (kept.some((k) => it.start < k.end && k.start < it.end)) continue;
    kept.push(it);
  }
  return kept;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

export class ExcerptError extends Error {}

/**
 * ブログ本文 1 本ぶんの抜粋案を返す。
 * `date` はそのミーグリの開催日 (JST の YYYY-MM-DD)、`formatLabel` は「オンライン」/「リアル」。
 */
export async function proposeExcerpts(
  content: string,
  context: { date: string; formatLabel: string; blogTitle: string }
): Promise<ExcerptProposal[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new ExcerptError("OPENAI_API_KEY が未設定です");
  if (!content.trim()) return [];

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `対象: ${context.date} の${context.formatLabel}ミート＆グリート\n` +
            `ブログ: ${context.blogTitle}\n\n` +
            `本文:\n${content}`,
        },
      ],
      response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
    }),
  });

  const json = (await res.json().catch(() => ({}))) as ChatResponse;
  if (!res.ok) {
    throw new ExcerptError(`抜粋の提案に失敗しました (${res.status}): ${json.error?.message ?? "不明なエラー"}`);
  }
  const raw = json.choices?.[0]?.message?.content;
  if (!raw) return [];

  let parsed: { excerpts?: { text: string; reason: string }[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExcerptError("抜粋の提案を読み取れませんでした");
  }

  const located: ExcerptProposal[] = [];
  for (const e of parsed.excerpts ?? []) {
    const pos = locateExcerpt(content, e.text);
    if (!pos) continue; // 原文に無い = 言い換えられているので採らない
    located.push({ text: content.slice(pos.start, pos.end), reason: e.reason, ...pos });
  }
  return dropOverlapping(located).slice(0, MAX_EXCERPTS_PER_BLOG);
}
