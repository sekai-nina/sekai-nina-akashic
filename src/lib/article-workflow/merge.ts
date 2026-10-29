/**
 * 既存の記事に新しい素材を AI に組み込ませる (#275)。DB に触らない純粋関数。
 *
 * 本文を AI / 人が書くテンプレート (スナップ・言葉 (場面)・おでかけ) の追記は、新しい素材を
 * 出典として足すだけで、本文への書き足しは人が行っていた (#268)。ここでは既存の本文と素材を
 * AI に渡して本文に組み込んだ案を作らせ、人が直してから保存する。
 *
 * **AI に許すのは「新しい行を差し込む」「既存の行の末尾に `^[n]` を足す」の 2 つだけ。**
 * 既存の行の書き換え・削除・並べ替えは `checkMerge` が弾く (人が直した文章を AI に壊させない)。
 * 人が画面で直した結果は検査しない (書き換えたいときは人が書き換える)。
 */

import { classifyMaterials, numberSources, type ArticleAssetInput, type RenderedSource } from "./render";
import type { AiPrompt } from "./templates/types";

/**
 * 記事に素材を取り込んだ (`Article.materialsSyncedAt`) あとで入れた、メモ・抜粋つきのクリップか。
 * 出典として載っている素材へのクリップは出典が増えないので、これで「新しい素材」と見る。
 * メモも抜粋も無いクリップは足す中身が無いので数えない。取り込んだ時刻が無い記事は判定しない
 */
export function isFreshClip(
  item: { createdAt: Date; note: string; excerpt: string },
  syncedAt: Date | null | undefined
): boolean {
  if (!syncedAt) return false;
  return item.createdAt > syncedAt && (item.note.trim() !== "" || item.excerpt.trim() !== "");
}

export interface FreshMaterial {
  excerpts: string[];
  notes: string[];
  itemIds: string[];
}

/**
 * 新しいメモ・抜粋を、組み立ての出典番号 (`numberSources`) ごとにまとめる。
 * ブログ画像はブログの番号に寄せる。素材に無いアセット (機密で落ちたもの等) は捨てる
 */
export function groupFreshBySource(
  assets: ArticleAssetInput[],
  items: { id: string; assetId: string; note: string; excerpt: string }[]
): Map<number, FreshMaterial> {
  const { blogs, talks } = classifyMaterials(assets);
  const { talkSourceNo } = numberSources(blogs, talks);
  const noByAsset = new Map(talkSourceNo);
  for (const b of blogs) {
    if (b.ref) noByAsset.set(b.ref, b.sourceNo);
    for (const img of b.images) noByAsset.set(img.id, b.sourceNo);
  }
  const out = new Map<number, FreshMaterial>();
  for (const item of items) {
    const no = noByAsset.get(item.assetId);
    if (no === undefined) continue;
    const m = out.get(no) ?? { excerpts: [], notes: [], itemIds: [] };
    m.itemIds.push(item.id);
    if (item.excerpt.trim()) m.excerpts.push(item.excerpt);
    if (item.note.trim()) m.notes.push(item.note.trim());
    out.set(no, m);
  }
  return out;
}

const SECTION_HEAD = /^### \^\[(\d+)\] /;

/**
 * `buildMaterialsText` の素材を、記事での出典番号に付け替える。
 * 素材の見出しは組み立ての番号 (`### ^[k] …`) なので、`renumber` (組み立て → 記事) で書き換え、
 * 記事に載らない (足さないと決めた) 出典の節は落とす。
 * `newNos` に入っている番号の節には「新しい素材」の印を付ける。
 * 既存の出典の中身は `buildMaterialsText` の `focus` で見出しだけにしてある (枠を新しい素材に回す)。
 * `sections` (画面に出す) は新しい素材の中身だけ
 */
export function renumberMaterials(
  text: string,
  renumber: ReadonlyMap<number, number>,
  newNos: ReadonlySet<number>
): { text: string; sections: { no: number; text: string }[] } {
  const lines = text.split("\n");
  const head: string[] = [];
  const sections: { no: number | null; lines: string[] }[] = [];
  for (const line of lines) {
    const m = line.match(SECTION_HEAD);
    if (m) {
      const to = renumber.get(Number(m[1])) ?? null;
      const mark = to !== null && newNos.has(to) ? "【新しい素材】" : "";
      sections.push({ no: to, lines: [to === null ? line : line.replace(SECTION_HEAD, `### ^[${to}] ${mark}`)] });
    } else if (sections.length === 0) {
      head.push(line);
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  const kept = sections
    .filter((s): s is { no: number; lines: string[] } => s.no !== null)
    .sort((a, b) => a.no - b.no)
    .map((s) => ({
      no: s.no,
      text: s.lines.join("\n").trimEnd(),
    }));
  return {
    text: [...head, ...kept.map((s) => `${s.text}\n`)].join("\n").trimEnd() + "\n",
    sections: kept.filter((s) => newNos.has(s.no)),
  };
}

/** 組み込みの指示。テンプレートのシステムプロンプト (形・鉄則・見本) はそのまま使い、作業だけ差し替える */
export function mergePrompt(input: {
  system: string[];
  title: string;
  existingBody: string;
  materials: string;
  newSources: { sourceNo: number; label: string }[];
  included: number;
  truncated: number;
}): AiPrompt {
  const user = [
    `記事のタイトル: ${input.title}`,
    "",
    "## 今回の作業 (新規作成ではなく、既存の記事への追記)",
    "",
    "下の「既存の本文」は公開済みの記事です。素材のうち【新しい素材】に書かれた事実のうち、",
    "この記事のタイトルに関係するものを、既存の本文に組み込んでください。",
    "",
    "やってよいことは次の 2 つだけです。",
    "1. **新しい行を差し込む。** 箇条書きなら関係の近い項目の後ろ・ネストの位置に、地の文なら段落の間に置く。",
    "   形 (リード・箇条書き・ネスト・`^[n]` の付け方) は既存の本文と見本に揃える",
    "2. **既存の行の末尾に `^[n]` を足す。** 新しい素材が既存の行と同じ事実を裏付けるとき",
    "",
    "**既存の行は 1 文字も変えない・消さない・並べ替えない。** 言い回しの調整や、既存の事実の書き直しが",
    "必要だと思っても行わない (人が後で直す)。既存の行に `^[n]` を足すときも、行の末尾にだけ付ける。",
    "新しい素材に、タイトルと関係する事実が無いなら、既存の本文をそのまま返す。",
    "出典番号は素材の見出しに書いてある番号をそのまま使う。新しい素材の番号: " +
      input.newSources.map((s) => `^[${s.sourceNo}] ${s.label}`).join(" / "),
    "",
    "body には組み込んだあとの本文全体を返す。tags / title / date / dateDisplay は使わない (空配列と null)。",
    "",
    "## 既存の本文",
    "",
    "```markdown",
    input.existingBody.trimEnd(),
    "```",
    "",
    input.materials,
  ].join("\n");
  return { system: input.system, user, included: input.included, truncated: input.truncated };
}

/** 行末の `^[n]` の並び */
const TRAILING_FOOTNOTES = /^(?:\^\[\d+\])+$/;

export type MergeCheck =
  | {
      ok: true;
      /** AI が差し込んだ行・`^[n]` を足した行 (`proposed` の 0 始まりの位置。画面で色を付ける) */
      changedLines: number[];
    }
  | { ok: false; reason: string };

/** 行末の空白を落とし、連続する空行を 1 つに、先頭・末尾の空行を除く */
function significantLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.length === 0 && (out.length === 0 || out[out.length - 1].length === 0)) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].length === 0) out.pop();
  return out;
}

/**
 * AI が本文をコードブロックで包んで返したら外す (プロンプトの「既存の本文」の囲みを真似ることがある)
 */
export function unwrapFence(body: string): string {
  const m = body.trim().match(/^```[a-z]*\n([\s\S]*?)\n```$/);
  return m ? `${m[1]}\n` : body;
}

/**
 * AI の案が「差し込み」と「既存の行の末尾への `^[n]` の追加」だけでできているか。
 * 段落の区切り (空行) は消せない (消すと Markdown で前後の段落・引用が繋がる)。空行を足すのは許す。
 * 行末の空白・連続する空行の数は見ない
 */
export function checkMerge(base: string, proposed: string): MergeCheck {
  const before = significantLines(base);
  const after = proposed.split("\n").map((l) => l.trimEnd());
  const changedLines: number[] = [];
  let i = 0;
  for (let j = 0; j < after.length; j++) {
    const line = after[j];
    const want = before[i];
    if (line.length === 0) {
      if (want === "") i++;
      continue;
    }
    // 空行の次の既存の行が空行を挟まずに来た = 段落の区切りを消した
    if (want === "" && line === before[i + 1]) {
      return {
        ok: false,
        reason: `AI が段落の区切り (「${(before[i - 1] ?? "").slice(0, 30)}」の後の空行) を消しました。もう一度試すか、手で書いてください`,
      };
    }
    if (want !== undefined && line === want) {
      i++;
      continue;
    }
    if (want !== undefined && line.startsWith(want) && TRAILING_FOOTNOTES.test(line.slice(want.length))) {
      i++;
      changedLines.push(j);
      continue;
    }
    changedLines.push(j);
  }
  if (i < before.length) {
    const what = before[i] === "" ? `段落の区切り (「${(before[i - 1] ?? "").slice(0, 30)}」の後の空行)` : `「${before[i].slice(0, 40)}」`;
    return {
      ok: false,
      reason: `AI が既存の行を書き換えたか消しました (${what})。もう一度試すか、手で書いてください`,
    };
  }
  return { ok: true, changedLines };
}

/**
 * 保存する本文と出典を決める。
 *
 * - 本文で参照されている新しい出典だけ足す。参照されなかったものは `unused` (「今後足さない」にする)
 * - 足す出典は既存の続きから**詰めて**採番し直す (`applySources` が max+1 で順に振るので、
 *   間の出典を落としたまま番号を残すと脚注の宛先がずれる)。本文の `^[n]` も同じく書き換える
 * - どの出典にも当たらない番号の `^[n]` は落とす (公開リポジトリに宛先の無い脚注を出さない)。
 *   `keepNos` (既存の出典の番号 + もとの本文にあった番号) は触らない。閲覧者のクリアランスでは見えない
 *   出典 (RLS で読めない) の番号も、もとの本文にあれば残る
 */
export function finalizeMerge(
  body: string,
  newSources: RenderedSource[],
  keepNos: ReadonlySet<number>
): { body: string; sources: RenderedSource[]; unused: RenderedSource[] } {
  const referenced = new Set([...body.matchAll(/\^\[(\d+)\]/g)].map((m) => Number(m[1])));
  const ordered = [...newSources].sort((a, b) => a.sourceNo - b.sourceNo);
  const used = ordered.filter((s) => referenced.has(s.sourceNo));
  const unused = ordered.filter((s) => !referenced.has(s.sourceNo));
  // `applySources` の採番 (`nextSourceNo`) は既存の行と本文の `^[n]` の最大値の続き。それに揃える
  const base = Math.max(0, ...keepNos);
  const map = new Map(used.map((s, idx) => [s.sourceNo, base + idx + 1]));
  const rewritten = body
    .replace(/\r\n?/g, "\n")
    .replace(/\^\[(\d+)\]/g, (whole, n) => {
      const no = Number(n);
      if (map.has(no)) return `^[${map.get(no)}]`;
      return keepNos.has(no) ? whole : "";
    })
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
  return {
    body: `${rewritten}\n`,
    sources: used.map((s) => ({ ...s, sourceNo: map.get(s.sourceNo)! })),
    unused,
  };
}
