/**
 * 言葉 (状況つき) 記事のテンプレート (#172)。
 *
 * 「yes, me now?」「え？ちいかわ？」のように、坂井新奈が**どんな状況で**その言葉を発したかを
 * 地の文で説明してから発言を引用ブロックで示す `type: quote` の記事。sekai-nina-site の
 * `dossier-to-quote-article` スキル (situational モード) の移植。本人ブログの名言をそのまま
 * 並べる `quote_blog` とは別物。
 *
 * - 本文 (AI): 状況の地の文 (いつ・どこで・誰と・何が起きて → どう発したか) → `>` 発言 → 反応 1 文
 * - タイトルは AI が実際の発言表記に整えてよい (ドシエタイトルは目安。`yes, me now?` → `Yes, me now?`)
 * - `date` / `date_display` は発言の時期、tags は関係するメンバー
 * - 関連メディアの章は出さない (既存記事に無い)
 */

import { buildMaterialsText } from "../materials";
import {
  classifyMaterials,
  dossierSnapshot,
  joinBody,
  numberSources,
  type ArticleParts,
  type RenderedArticle,
} from "../render";
import { EDITORIAL_RULES, normalizeAiBody, normalizeAiTags } from "./shared";
import type { AiContext, AiDraft, AiPrompt, ArticleTemplateDef, DossierRenderInput } from "./types";

/** AI が使えなかったときに本文に置くプレースホルダ。記事編集画面で人が置き換える */
export const QUOTE_SITUATIONAL_BODY_PLACEHOLDER =
  "<!-- 本文: AI が使えなかったので、素材を読んで書いてください。状況の地の文 → > 発言 → 反応 1 文。各文に ^[n] で出典 -->";

/** 見本にする既存記事 (公開済み) */
const SAMPLES = [
  {
    title: "Yes, me now?",
    dossierTitle: "yes, me now?",
    date: "2025-09-15",
    dateDisplay: "2025年9月頃",
    tags: ["大野愛実"],
    body: `リハーサル中のやり取りで坂井新奈が発した一言。同期の大野愛実のブログで紹介された^[1]。

2025年9月頃、ツアーのリハーサル期間中のエピソード。リハーサルに疲れていた坂井新奈を見た大野愛実が「休みな」と声をかけたところ、坂井新奈はこう返した^[1]。

> Yes, me now?

大野愛実はこの返しに「母性が溢れて涙が出そうでした」と綴り、「リハ、がんばろうと思えた」としている^[1]。`,
  },
  {
    title: "え？ちいかわ？",
    dossierTitle: "え？ちいかわ？",
    date: "2025-09-15",
    dateDisplay: "2025年9月頃",
    tags: ["大野愛実", "佐藤優羽", "高井俐香"],
    body: `食事中のリアクションに対して坂井新奈が放ったツッコミ。同期の大野愛実のブログで紹介された^[1]。

2025年9月頃、リハーサル終わりに大野愛実・坂井新奈・佐藤優羽・高井俐香の4人で食事に行った際のエピソード^[1]。料理が運ばれてきた瞬間、向かいに座っていた高井俐香と佐藤優羽が「うわぁあああ🤩🥹✨✨✨」と大きく反応した^[1]。その様子に、坂井新奈はこうツッコんだ^[1]。

> え？ちいかわ？(迫真)

大野愛実は2人の様子を「まるで初めて食事を体験するなんかちいさくてかわいいやつみたいでした」と表現し、「あの坂井大先生をツッコませるほどの大ボケ」と綴っている^[1]。`,
  },
];

const RULES = `あなたは日向坂46・坂井新奈のアーカイブサイト「世界新奈」の編集者です。
ドシエ (素材の束) を読んで、「言葉」記事の本文を書きます。ここでの言葉記事とは、坂井新奈が発した
印象的な一言について、**どんな状況で発したか**を地の文で説明してから、その発言を引用ブロックで示す
\`type: quote\` の記事です。

## 本文の形

- 1 段落目: その言葉が何か・どこで紹介されたかを 1〜2 文で (例: 「リハーサル中のやり取りで坂井新奈が
  発した一言。同期の大野愛実のブログで紹介された^[1]。」)
- 2 段落目: **状況の説明**。いつ・どこで・誰と・何が起きて → 坂井新奈がどう発したか、を地の文で。
  文ごとに出典 \`^[n]\` を付ける (n は素材の番号をそのまま。番号の無い出典を作らない)
- 続けて **発言そのもの**を引用ブロック \`> \` で 1 つ。原文の表記のまま (絵文字・記号も)
- 最後に、発言のあとの反応・オチを 1 文 (相手がどう受け止めたか等)。無ければ書かない
- \`{q}\` \`{/q}\` は付けない (それは別の機能)。見出し (#) は使わない。frontmatter やタイトルも書かない
- 既存記事へのリンクは \`[[記事タイトル]]\`。**「既存記事のタイトル」に挙げたものだけ**

${EDITORIAL_RULES}

- 他メンバーの言動は「坂井新奈の発言の状況説明に必要な範囲」でだけ書く (発言の相手・きっかけ・反応)

## 出力

JSON で返す。
- body: 本文 (Markdown)。上の形に従う
- tags: 「既存のタグ」から 0〜4 個。**発言に関係するメンバーの名前** (相手・同席者)。出典の種類や
  時期を表すタグ (ninatalk / ブログ / 2026年 など) は付けない
- title: 記事のタイトル = **実際の発言の表記**。ドシエのタイトルは目安なので、素材の原文に合わせて
  整える (例: ドシエ「yes, me now?」→ "Yes, me now?")。ドシエのタイトルで既に正しければ null
- date: 発言の日 "YYYY-MM-DD"。日が分からなければその月の 1 日。月も分からなければ null
- dateDisplay: 日が確かなら null。月までなら "2025年9月頃" のように

## 見本 (既存記事。この形に揃える)

${SAMPLES.map(
  (s) =>
    `### ドシエ「${s.dossierTitle}」→ title: ${s.title} (date: ${s.date}, dateDisplay: ${s.dateDisplay}, tags: ${s.tags.join(", ")})\n${s.body}`
).join("\n\n")}
`;

/** システムプロンプト。鉄則・見本 と 語彙 を別ブロックに (前半のキャッシュを残す) */
export function quoteSituationalSystemPrompt(context: AiContext): string[] {
  return [
    RULES,
    [
      "## 既存のタグ (tags はここから選ぶ)",
      context.tagVocabulary.join("、") || "(なし)",
      "",
      "## 既存記事のタイトル ([[…]] でリンクしてよいのはこれだけ)",
      context.existingTitles.map((t) => `- ${t}`).join("\n") || "(なし)",
      "",
    ].join("\n"),
  ];
}

export function quoteSituationalPrompt(input: DossierRenderInput, context: AiContext): AiPrompt {
  const materials = buildMaterialsText(input);
  return {
    system: quoteSituationalSystemPrompt(context),
    user: [
      `ドシエのタイトル (= 言葉の目安): ${input.dossier.title}`,
      "",
      "以下の素材から、坂井新奈がこの言葉をどんな状況で発したかを本文にしてください。",
      "",
      materials.text,
    ].join("\n"),
    included: materials.included,
    truncated: materials.truncated,
  };
}

export function renderQuoteSituationalArticle(input: DossierRenderInput, draft?: AiDraft | null): RenderedArticle {
  const { blogs, talks } = classifyMaterials(input.assets);
  const { sources } = numberSources(blogs, talks);

  const hasDraft = !!draft && draft.body.trim().length > 0;
  const body = hasDraft ? normalizeAiBody(draft.body, sources.length) : `${QUOTE_SITUATIONAL_BODY_PLACEHOLDER}\n`;
  const tags = hasDraft ? normalizeAiTags(draft.tags) : [];
  const title = (hasDraft && draft.title?.trim()) || input.dossier.title;

  // 追記の対象になる章は無い (本文は AI / 人が持つ。関連メディアも出さない)
  const parts: ArticleParts = { quotes: [], reports: [], tiktoks: [], talks: [], blogImages: [] };

  return {
    title,
    tags,
    body: joinBody([body]),
    sources,
    parts,
    dates: {
      date: hasDraft ? draft.date : null,
      dateDisplay: hasDraft ? draft.dateDisplay : null,
      dateMode: null,
    },
    draft: true,
    frontmatterExtra: { dossier: dossierSnapshot(input.dossier, input.today) },
  };
}

export const QUOTE_SITUATIONAL_TEMPLATE: ArticleTemplateDef = {
  key: "quote_situational",
  articleType: "quote",
  needsAi: true,
  // 追記で足す章は無い (`parts` は常に空)。`AppendLayout.reports` が必須なので名前だけ置く
  appendLayout: {
    quotesHeading: null,
    quoteAttribution: false,
    reports: { heading: "## ファンの反応", lead: "ファンの投稿（X）。" },
  },
  render: renderQuoteSituationalArticle,
  prompt: quoteSituationalPrompt,
};
