/**
 * AI に渡す素材の組み立て (#171)。DB に触らない純粋関数。
 *
 * ドシエのアセットを出典の単位 (ブログ 1 本 / トーク 1 件) にまとめ、**記事に載る出典番号
 * (`numberSources`) と同じ番号**を付けて並べる。AI は本文の `^[n]` にこの番号を使うので、
 * ここと `render` の採番がずれると脚注が宛先を失う。
 *
 * 渡すもの: 本文全文 (ブログ / トーク)、人が選んだ抜粋 (重要箇所として明示)、メディアの
 * キャプション、人物エンティティ。長すぎる本文は切って件数を返す (画面に出す)。
 */

import {
  classifyMaterials,
  numberSources,
  type ArticleAssetInput,
  type BlogGroup,
} from "./render";
import type { DossierRenderInput } from "./templates/types";

/** 1 つの出典 (ブログ 1 本 / トーク 1 件) の本文の上限文字数 */
export const MAX_CHARS_PER_SOURCE = 12_000;
/**
 * 素材全体の上限文字数。日本語は Claude ではおおむね 1 文字 1 トークンなので ≈ 8 万トークン
 * (Opus 5 で $0.4 程度)。超えた出典は本文を切る
 */
export const MAX_CHARS_TOTAL = 80_000;
/** 全体の上限に達しても、出典ごとに最低これだけは本文を残す (後ろの短いトークが丸ごと消えないように) */
const MIN_CHARS_PER_SOURCE = 1_000;

export interface MaterialsText {
  text: string;
  /** 素材に入れた出典の数 (本文・抜粋・キャプションのどれかがあるもの) */
  included: number;
  /** 本文を切った出典の数 */
  truncated: number;
}

function truncate(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  return { text: `${text.slice(0, limit)}\n…（以下略。${text.length - limit} 字を省略）`, cut: true };
}

function quoteLines(excerpt: string): string {
  return `> ${excerpt.replace(/\r\n?/g, "\n").split("\n").join("\n> ")}`;
}

function joinPeople(assets: ArticleAssetInput[]): string[] {
  const seen = new Set<string>();
  for (const a of assets) for (const p of a.people ?? []) seen.add(p);
  return [...seen];
}

interface Section {
  text: string;
  cut: boolean;
  /** 本文・抜粋・キャプションのどれかがある (AI に読ませる価値がある) */
  hasContent: boolean;
}

/** 見出し行のあとに、抜粋・キャプション・本文を並べる (ブログとトークで共通) */
function section(
  header: string[],
  parts: { excerpts: string[]; captions: string[]; body: string | null; noBodyNote: string },
  budget: number
): Section {
  const lines = [...header];
  if (parts.excerpts.length > 0) {
    lines.push("", "人が選んだ重要箇所 (抜粋):");
    for (const ex of parts.excerpts) lines.push(quoteLines(ex));
  }
  if (parts.captions.length > 0) {
    lines.push("", "画像のキャプション:");
    for (const c of parts.captions) lines.push(`- ${c}`);
  }
  let cut = false;
  const body = parts.body?.trim();
  if (body) {
    const t = truncate(body.replace(/\r\n?/g, "\n"), budget);
    cut = t.cut;
    lines.push("", "本文:", t.text);
  } else {
    lines.push("", parts.noBodyNote);
  }
  return {
    text: lines.join("\n"),
    cut,
    hasContent: !!body || parts.excerpts.length > 0 || parts.captions.length > 0,
  };
}

function blogSection(b: BlogGroup, textAsset: ArticleAssetInput | undefined, budget: number): Section {
  const header = [`### ^[${b.sourceNo}] ${b.title}${b.date ? `（${b.date}）` : ""}`];
  if (b.url) header.push(`URL: ${b.url}`);
  const people = joinPeople(textAsset ? [textAsset, ...b.images] : b.images);
  if (people.length > 0) header.push(`登場人物: ${people.join("、")}`);
  return section(
    header,
    {
      excerpts: b.excerpts,
      captions: b.images.map((i) => i.caption?.trim()).filter((c): c is string => !!c),
      body: textAsset?.text ?? null,
      noBodyNote: "(本文なし。画像だけのブログ)",
    },
    budget
  );
}

function talkSection(a: ArticleAssetInput, sourceNo: number | undefined, budget: number): Section {
  const header = [`### ^[${sourceNo}] ${a.title}${a.canonicalDate ? `（${a.canonicalDate}）` : ""}`];
  if (a.people && a.people.length > 0) header.push(`登場人物: ${a.people.join("、")}`);
  const caption = a.caption?.trim();
  return section(
    header,
    {
      excerpts: a.excerpts,
      captions: caption ? [caption] : [],
      body: a.text ?? null,
      noBodyNote: `(本文なし。${a.kind === "video" ? "動画" : "画像"}のトーク)`,
    },
    budget
  );
}

/**
 * 素材を Markdown 風の 1 つの文字列にする。出典番号は `render` と同じ (`numberSources`)。
 * 呼び出し側は `input.assets` を**機密で絞ったあと**で渡すこと (ここでは見ない)
 */
export function buildMaterialsText(input: DossierRenderInput): MaterialsText {
  const { blogs, talks } = classifyMaterials(input.assets);
  const { talkSourceNo } = numberSources(blogs, talks);
  const textAssetById = new Map(input.assets.filter((a) => a.kind === "text").map((a) => [a.id, a]));

  const parts: string[] = [`# ドシエ「${input.dossier.title}」の素材`, ""];
  let remaining = MAX_CHARS_TOTAL;
  let truncated = 0;
  let included = 0;

  const push = (sec: Section) => {
    parts.push(sec.text, "");
    // 本文以外 (見出し・抜粋・キャプション) も枠を使うが、出典ごとの最低枠は残す
    remaining = Math.max(remaining - sec.text.length, 0);
    if (sec.cut) truncated++;
    if (sec.hasContent) included++;
  };
  const budget = () => Math.max(Math.min(MAX_CHARS_PER_SOURCE, remaining), MIN_CHARS_PER_SOURCE);

  for (const b of blogs) {
    const textAsset = b.ref ? textAssetById.get(b.ref) : undefined;
    push(blogSection(b, textAsset, budget()));
  }
  for (const a of talks) push(talkSection(a, talkSourceNo.get(a.id), budget()));

  return { text: parts.join("\n").trimEnd() + "\n", included, truncated };
}
