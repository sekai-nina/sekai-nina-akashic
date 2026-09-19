/**
 * 「本人の感想」の抜粋提案 (#108)。
 *
 * ドシエに入れたブログ本文から、そのミーグリについて書いている範囲を LLM に選ばせ、
 * `DossierItem` の抜粋 (excerptStart / excerptEnd) の候補として返す。
 *
 * **公開サイトの引用になる文面なので、提案をそのまま採用はしない。** 画面でチェックして
 * ドシエに入れ、細かい範囲は人が直す前提。
 *
 * 位置の確定 (`locateExcerpt`) は DB に触らない純粋関数なのでテストがある。
 */

import type { ExcerptProposal } from "./types";

/**
 * 原文どおりの部分文字列を返させる仕事なので、**安いモデルに落とさないこと。**
 * `locateExcerpt` は言い換えを黙って捨てるので、モデルが弱いと
 * 「候補が見つかりませんでした」に化けるだけで、劣化が画面から見えない。
 *
 * 実ブログ 6 本 (8,118 字) で 2 回ずつ測って決めた (2026-09-20)。
 * 「返した件数 → そのうち原文どおりだった件数」が劣化の指標:
 *
 * | モデル | 返した → 原文どおり | 位置が確定した提案 | 6 本ぶんの費用 |
 * |---|---|---|---|
 * | gpt-4.1 (旧) | 10→10 / 11→11 (100%) | 10, 11 件 | $0.033 |
 * | gpt-5.6-terra | 10→10 / 10→10 (100%) | 10, 10 件 | $0.051 |
 * | gpt-5.6-luna | 17→14 (82%) / 15→14 (93%) | 14, 14 件 | $0.007 |
 * | **gpt-5.4-mini** | 15→14 (93%) / 13→13 (100%) | **14, 13 件** | $0.016 |
 *
 * gpt-5.4-mini を採った。**使える候補がむしろ増えて** (10-11 件 → 13-14 件)、
 * 費用は半分以下になる。luna は 1/5 の値段だが言い換えが 2 割混じる回がある。
 * terra は旧と同等だが高い。
 */
const OPENAI_MODEL = "gpt-5.4-mini";
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
- **本文に現れる順に返してください**
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
 *
 * `from` は探し始める位置。**同じ言い回しがブログ内で繰り返されることがある**ので、
 * 呼び出し側は前の抜粋の終わりを渡して前から順に埋めていく（毎回 0 から探すと、
 * 2 つめ以降が 1 つめと同じ場所に解決してしまう）。
 */
export function locateExcerpt(
  content: string,
  quote: string,
  from = 0
): { start: number; end: number } | null {
  const trimmed = quote.trim();
  if (!trimmed) return null;

  const direct = content.indexOf(trimmed, from);
  if (direct >= 0) return { start: direct, end: direct + trimmed.length };

  const haystack = normalize(content);
  const needle = normalize(trimmed);
  if (!needle.text) return null;

  // from (元の添字) を正規化後の添字に直してから探す
  let normFrom = 0;
  while (normFrom < haystack.map.length && haystack.map[normFrom] < from) normFrom++;

  const at = haystack.text.indexOf(needle.text, normFrom);
  if (at < 0) return null;

  const start = haystack.map[at];
  const lastIdx = at + needle.text.length - 1;
  const end = haystack.map[lastIdx] + 1;
  return { start, end };
}

/**
 * 重なり合う提案を落とす。
 * **長いほうを残す**（短い一文が、それを含む長い振り返りを追い出さないように）。
 */
export function dropOverlapping(items: ExcerptProposal[]): ExcerptProposal[] {
  const sorted = [...items].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start); // 同じ開始位置なら長いほうを先に
  });
  const kept: ExcerptProposal[] = [];
  for (const it of sorted) {
    const clash = kept.findIndex((k) => it.start < k.end && k.start < it.end);
    if (clash >= 0) {
      // 後から来たほうが長ければ入れ替える
      if (it.end - it.start > kept[clash].end - kept[clash].start) kept[clash] = it;
      continue;
    }
    kept.push(it);
  }
  return kept.sort((a, b) => a.start - b.start);
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
      // temperature は送らない (gpt-5 系は指定すると 400)。毎回同じ提案にはならなくなるが、
      // どのみち人が選んでから入れるので、決定性より原文一致率を取る
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
    // OpenAI の本文はキーの一部や組織 ID を含むことがあるので、そのまま画面に出さない
    console.error("[meetgreet/excerpt] OpenAI error", res.status, json.error?.message);
    throw new ExcerptError(`抜粋の提案に失敗しました (${res.status})`);
  }
  const raw = json.choices?.[0]?.message?.content;
  if (!raw) return [];

  let parsed: { excerpts?: { text: string; reason: string }[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExcerptError("抜粋の提案を読み取れませんでした");
  }

  // 本文に現れる順に返させているので、前の抜粋の終わりから探す
  let cursor = 0;
  const located: ExcerptProposal[] = [];
  for (const e of parsed.excerpts ?? []) {
    let pos = locateExcerpt(content, e.text, cursor);
    // 順序が前後していたら先頭から探し直す (それでも無ければ言い換えなので捨てる)
    if (!pos && cursor > 0) pos = locateExcerpt(content, e.text);
    if (!pos) continue;
    located.push({ text: content.slice(pos.start, pos.end), reason: e.reason, ...pos });
    cursor = Math.max(cursor, pos.end);
  }
  return dropOverlapping(located).slice(0, MAX_EXCERPTS_PER_BLOG);
}
