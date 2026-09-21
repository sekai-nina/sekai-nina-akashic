/**
 * スナップ (attribute) 記事のテンプレート (#171)。
 *
 * 「坂井新奈は〜である」という属性 (癖・好み・性格・エピソード) を、素材 (ブログ / トーク) から
 * **事実の箇条書き**にまとめる。既存 102 本 (`src/content/articles/attribute/`) の形:
 *
 * - リード 1 文 + `- ` の箇条書き。各事実に `^[n]`。細部は tab でネスト
 * - `date` は持たない。tags は人物 / トピック
 * - 関連メディアの章は出さない (既存記事に無い)
 *
 * 本文は AI が書く (`needsAi`)。鉄則は sekai-nina-site の
 * `dossier-to-outing-article/SKILL.md` の「編集の鉄則」をそのまま持ち込む。
 * AI が使えないときは骨組み (出典だけ採番済み、本文はプレースホルダ) を返し、人が書く。
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
export const ATTRIBUTE_BODY_PLACEHOLDER =
  "<!-- 本文: AI が使えなかったので、素材を読んで書いてください。リード 1 文 + 事実の箇条書き、各事実に ^[n] で出典 -->";

/** 見本にする既存記事 (公開済み)。文体・粒度・出典の付け方を揃えるために丸ごと見せる */
const SAMPLES = [
  {
    title: "方向音痴",
    body: `坂井新奈はかなりの方向音痴である。

- 同期の高井俐香と2人で外出した際、揃って方向音痴すぎて3時間半ほど道に迷ったことがある（[[高井俐香と3時間半迷子になった]]）
- 家に帰ろうとすると違うところへ行ってしまうことがあるという^[1]
\t- ただし、これは[[坂井新奈から松尾桜への手紙|松尾桜へ嘘の最寄り駅を伝えていたこと]]が関係する可能性がある
\t\t- 普段使っていない駅で降りて帰っていたために、道に迷うことがあったのかもしれない
- 鶴崎仁香によると、坂井新奈は「すごく静かに道を間違える」らしい^[2]`,
    tags: ["高井俐香", "鶴崎仁香"],
  },
  {
    title: "好きなお寿司のネタ",
    body: `坂井新奈が好きなお寿司のネタについてまとめる。

- 一番好きなのはエビ^[1]
- とびこ^[1]
- 穴子^[1]
- えんがわ^[1]`,
    tags: ["お寿司"],
  },
  {
    title: "洋服のタグは切る",
    body: `- 坂井新奈は洋服のタグを切る^[1]`,
    tags: [],
  },
];

const RULES = `あなたは日向坂46・坂井新奈のアーカイブサイト「世界新奈」の編集者です。
ドシエ (素材の束) を読んで、「スナップ」記事の本文を書きます。スナップとは「坂井新奈は〜である」
という属性 (癖・好み・性格・家族・幼少期のエピソードなど) を、素材に書かれた事実だけで
淡々とまとめた短い記事です。

## 本文の形

- 1 文目はリード。「坂井新奈は〜である。」「坂井新奈の〜についてまとめる。」のように、記事の
  タイトル (= 属性) を 1 文で言い切る。事実が 1 つしか無いなら、リード無しで箇条書きだけでもよい
- 続けて \`- \` の箇条書きで事実を並べる。1 項目 1 事実。細部・補足・推測は tab でネストする
- **各事実の末尾に出典を \`^[n]\` で付ける。** n は素材に書いてある番号をそのまま使う。
  番号の無い出典を作らない。1 つの事実に複数の出典があれば \`^[1]^[2]\` と並べる
- 見出し (#) は使わない。「関連メディア」の章も作らない。frontmatter やタイトルも書かない
- 既存記事へのリンクは \`[[記事タイトル]]\` (表示を変えるなら \`[[記事タイトル|表示]]\`)。
  **リンクしてよいのは「既存記事のタイトル」に挙げたものだけ。** 無いタイトルを作らない
- 本人の特徴的な言い回しは「」で短く引いてよい (「すごく静かに道を間違える」程度)。
  長い引用はしない。ブログの文章をそのまま貼らず、事実に言い換える
- 推測を書くなら「〜と思われる」「〜かもしれない」「不明」と明示する。断定しない

${EDITORIAL_RULES}

## 出力

JSON で返す。
- body: 本文 (Markdown)。上の形に従う
- tags: 記事のタグ。「既存のタグ」から 0〜4 個選ぶ。記事の主題を表すもの (人物名・トピック・
  カテゴリ) だけ。**出典の種類や時期を表すタグ (ninatalk / ブログ / 2026年 など) は付けない。**
  登場する他メンバーの名前は入れてよい。タイトルそのものはタグにしない
- title / date / dateDisplay: この記事の型では使わない。null を返す

## 見本 (既存記事。この形に揃える)

${SAMPLES.map((s) => `### 「${s.title}」 (tags: ${s.tags.length ? s.tags.join(", ") : "なし"})\n${s.body}`).join("\n\n")}
`;

/**
 * システムプロンプト。鉄則・見本 (滅多に変わらない) と語彙 (既存タグ・既存記事タイトル。記事を保存すると
 * 変わる) を**別のブロック**にして、語彙が変わっても前半のキャッシュが残るようにする。
 * **ブロック内の順番を変えない** (先頭からの一致で prompt caching が効く)
 */
export function attributeSystemPrompt(context: AiContext): string[] {
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

export function attributePrompt(input: DossierRenderInput, context: AiContext): AiPrompt {
  const materials = buildMaterialsText(input);
  return {
    system: attributeSystemPrompt(context),
    user: [
      `記事のタイトル (= まとめる属性): ${input.dossier.title}`,
      "",
      "以下の素材から、このタイトルについて分かる事実だけを本文にしてください。",
      "",
      materials.text,
    ].join("\n"),
    included: materials.included,
    truncated: materials.truncated,
  };
}

export function renderAttributeArticle(input: DossierRenderInput, draft?: AiDraft | null): RenderedArticle {
  const { blogs, talks } = classifyMaterials(input.assets);
  const { sources } = numberSources(blogs, talks);

  // 空の本文は「下書き無し」と同じ (骨組みだけにする)
  const hasDraft = !!draft && draft.body.trim().length > 0;
  const body = hasDraft ? normalizeAiBody(draft.body, sources.length) : `${ATTRIBUTE_BODY_PLACEHOLDER}\n`;
  const tags = hasDraft ? normalizeAiTags(draft.tags) : [];

  // 追記の対象になる章は無い (本文は AI / 人が持つ)。出典だけ足せるよう内訳は空
  const parts: ArticleParts = { quotes: [], reports: [], tiktoks: [], talks: [], blogImages: [] };

  return {
    title: input.dossier.title,
    tags,
    body: joinBody([body]),
    sources,
    parts,
    dates: { date: null, dateDisplay: null, dateMode: null },
    // AI が書いた (または人が書く) 本文は、人が見るまで下書き
    draft: true,
    frontmatterExtra: { dossier: dossierSnapshot(input.dossier, input.today) },
  };
}

export const ATTRIBUTE_TEMPLATE: ArticleTemplateDef = {
  key: "attribute",
  articleType: "attribute",
  needsAi: true,
  // 追記で足す章は無い (`parts` は常に空)。`AppendLayout.reports` が必須なので名前だけ置く
  appendLayout: {
    quotesHeading: null,
    quoteAttribution: false,
    reports: { heading: "## ファンの反応", lead: "ファンの投稿（X）。" },
  },
  render: renderAttributeArticle,
  prompt: attributePrompt,
};
