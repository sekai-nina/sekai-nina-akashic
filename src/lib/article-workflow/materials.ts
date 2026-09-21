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
/** 素材全体の上限文字数 (≈ 4 万トークン)。超えた出典は本文を切る */
export const MAX_CHARS_TOTAL = 80_000;

export interface MaterialsText {
  text: string;
  /** 素材に入れた出典の数 */
  included: number;
  /** 本文を切った出典の数 */
  truncated: number;
}

function truncate(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  return { text: `${text.slice(0, limit)}\n…（以下略。${text.length - limit} 字を省略）`, cut: true };
}

function joinPeople(assets: ArticleAssetInput[]): string[] {
  const seen = new Set<string>();
  for (const a of assets) for (const p of a.people ?? []) seen.add(p);
  return [...seen];
}

function blogSection(b: BlogGroup, textAsset: ArticleAssetInput | undefined, budget: number) {
  const lines: string[] = [];
  lines.push(`### ^[${b.sourceNo}] ${b.title}${b.date ? `（${b.date}）` : ""}`);
  if (b.url) lines.push(`URL: ${b.url}`);
  const people = joinPeople(textAsset ? [textAsset, ...b.images] : b.images);
  if (people.length > 0) lines.push(`登場人物: ${people.join("、")}`);
  if (b.excerpts.length > 0) {
    lines.push("", "人が選んだ重要箇所 (抜粋):");
    for (const ex of b.excerpts) lines.push(`> ${ex.replace(/\r\n?/g, "\n").split("\n").join("\n> ")}`);
  }
  const captions = b.images.map((i) => i.caption?.trim()).filter((c): c is string => !!c);
  if (captions.length > 0) {
    lines.push("", "画像のキャプション:");
    for (const c of captions) lines.push(`- ${c}`);
  }
  let cut = false;
  const body = textAsset?.text?.trim();
  if (body) {
    const t = truncate(body.replace(/\r\n?/g, "\n"), Math.max(0, budget));
    cut = t.cut;
    lines.push("", "本文:", t.text);
  } else {
    lines.push("", "(本文なし。画像だけのブログ)");
  }
  return { text: lines.join("\n"), cut, used: lines.join("\n").length };
}

function talkSection(a: ArticleAssetInput, sourceNo: number | undefined, budget: number) {
  const lines: string[] = [];
  lines.push(`### ^[${sourceNo}] ${a.title}${a.canonicalDate ? `（${a.canonicalDate}）` : ""}`);
  if (a.people && a.people.length > 0) lines.push(`登場人物: ${a.people.join("、")}`);
  if (a.caption?.trim()) lines.push(`キャプション: ${a.caption.trim()}`);
  if (a.excerpts.length > 0) {
    lines.push("", "人が選んだ重要箇所 (抜粋):");
    for (const ex of a.excerpts) lines.push(`> ${ex.replace(/\r\n?/g, "\n").split("\n").join("\n> ")}`);
  }
  let cut = false;
  const body = a.text?.trim();
  if (body) {
    const t = truncate(body.replace(/\r\n?/g, "\n"), Math.max(0, budget));
    cut = t.cut;
    lines.push("", "本文:", t.text);
  } else {
    lines.push("", `(本文なし。${a.kind === "video" ? "動画" : "画像"}のトーク)`);
  }
  return { text: lines.join("\n"), cut, used: lines.join("\n").length };
}

/**
 * 素材を Markdown 風の 1 つの文字列にする。出典番号は `render` と同じ (`numberSources`)。
 * 呼び出し側は `input.assets` を**機密で絞ったあと**で渡すこと (ここでは見ない)
 */
export function buildMaterialsText(input: DossierRenderInput): MaterialsText {
  const { blogs, talks } = classifyMaterials(input.assets);
  const { talkSourceNo } = numberSources(blogs, talks);
  const textAssetById = new Map(input.assets.filter((a) => a.kind === "text").map((a) => [a.id, a]));

  const parts: string[] = [];
  let remaining = MAX_CHARS_TOTAL;
  let truncated = 0;
  let included = 0;

  parts.push(`# ドシエ「${input.dossier.title}」の素材`, "");
  for (const b of blogs) {
    const textAsset = b.ref ? textAssetById.get(b.ref) : undefined;
    const sec = blogSection(b, textAsset, Math.min(MAX_CHARS_PER_SOURCE, remaining));
    parts.push(sec.text, "");
    remaining -= sec.used;
    if (sec.cut) truncated++;
    included++;
  }
  for (const a of talks) {
    const sec = talkSection(a, talkSourceNo.get(a.id), Math.min(MAX_CHARS_PER_SOURCE, remaining));
    parts.push(sec.text, "");
    remaining -= sec.used;
    if (sec.cut) truncated++;
    included++;
  }
  return { text: parts.join("\n").trimEnd() + "\n", included, truncated };
}
