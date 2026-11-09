/**
 * 物 (item) 記事のテンプレート。
 *
 * 坂井新奈が持っている・もらった・使っている物を、素材 (ブログ / トーク) の言及から
 * **事実の箇条書き**にまとめる `type: item` の記事。既存の手書き 2 本 (`src/content/articles/item/`) の形:
 *
 * - 本文 (AI): リード 1〜2 文 (どんな物か + 何をもとにまとめたか) → `- ` の箇条書き、各事実に `^[n]`。細部は tab でネスト
 * - 冒頭の画像 (機械): 企画の外部画像 (キャプション「サムネ」、無ければ先頭の 1 枚)。frontmatter の `thumbnail` にも
 *   入れ、公開サイトの「物」の一覧に出す
 * - `## 購入リンク` (機械): 企画の外部リンクのカード。素材としては AI に渡さない。TikTok は関連メディアの埋め込みのまま
 * - `## 関連メディア` (機械): おでかけと同じ。画像・動画のトークとブログ画像をリンクで、TikTok を埋め込みで、
 *   1 つの箇条書きに (flat)。文章のトークは出典にだけ使う
 * - `date` / `date_display` / tags は AI の提案 (その物が話に出た時期、関係するメンバー + カテゴリ)
 * - タイトルはドシエのタイトル (= 物の名前)
 *
 * AI が使えないときは骨組み (出典と関連メディアだけ、本文はプレースホルダ) を返し、人が書く。
 */

import { buildMaterialsText } from "../materials";
import {
  buildParts,
  classifyMaterials,
  dossierSnapshot,
  ITEM_NINA_MEDIA_HEADING,
  joinBody,
  linkCard,
  numberSources,
  renderLinksSection,
  renderRelatedMediaSection,
  type RelatedMediaStyle,
  type RenderedArticle,
} from "../render";
import {
  AI_BODY_APPEND_LAYOUT,
  aiSystemPrompt,
  EDITORIAL_RULES,
  normalizeAiBody,
  normalizeAiTags,
  stripRelatedMedia,
} from "./shared";
import type { AiContext, AiDraft, AiPrompt, ArticleTemplateDef, DossierRenderInput } from "./types";

/** AI が使えなかったときに本文に置くプレースホルダ。記事編集画面で人が置き換える */
export const ITEM_BODY_PLACEHOLDER =
  "<!-- 本文: AI が使えなかったので、素材を読んで書いてください。リード 1〜2 文 + 事実の箇条書き、各事実に ^[n] で出典 -->";

const ITEM_MEDIA_STYLE: RelatedMediaStyle = { kind: "flat", ninaHeading: ITEM_NINA_MEDIA_HEADING };

/** 見本にする既存記事 (公開済み)。文体・粒度・出典の付け方を揃えるために丸ごと見せる */
const SAMPLES = [
  {
    title: "赤い服を着たカンガルーのぬいぐるみ",
    date: "2025-06-29",
    dateDisplay: "2025年6月頃",
    tags: ["富田鈴花", "ぬいぐるみ"],
    body: `坂井新奈が先輩からもらった、赤い服を着たカンガルーのぬいぐるみ。2025年6月29日のブログでの言及をもとにまとめる。

- 坂井新奈は、富田鈴花からオーストラリア土産として赤い服を着たカンガルーのぬいぐるみをもらった^[1]
\t- 「とっても可愛い」と述べ、「大切にします」と綴っている^[1]`,
  },
  {
    title: "柔道着",
    date: "2026-02-10",
    dateDisplay: "2026年2月",
    tags: ["森本茉莉", "わらしべ長者"],
    body: `坂井新奈が持っていた柔道着について。日向坂ちゃんねるの「わらしべ長者」企画に持参した品として登場する。

- 坂井新奈は、日向坂ちゃんねるの「わらしべ長者」企画に、家から柔道着を持ってきた^[1]
\t- 動画内では、森本茉莉が坂井新奈から柔道着を受け取っていた^[1]
- 後日、森本茉莉は坂井新奈に柔道着を返した^[2]`,
  },
];

const RULES = `あなたは日向坂46・坂井新奈のアーカイブサイト「世界新奈」の編集者です。
ドシエ (素材の束) を読んで、「物」記事の本文を書きます。物記事とは、坂井新奈が持っている・
もらった・使っている物 (ぬいぐるみ・服・私物など) について、素材に書かれた事実だけを
淡々とまとめた \`type: item\` の短い記事です。

## 本文の形

- **リード 1〜2 文**: どんな物かを言い切り、何をもとにまとめたか、どこで話に出たかを続ける
  (「坂井新奈が先輩からもらった、〜。2025年6月29日のブログでの言及をもとにまとめる。」のように)
- 続けて \`- \` の箇条書きで事実を並べる。1 項目 1 事実。入手の経緯 → 使い方・本人の感想 → その後、の
  順を目安にする。細部・補足は tab でネストする
- **各事実の末尾に出典を \`^[n]\` で付ける。** n は素材に書いてある番号をそのまま使う。
  番号の無い出典を作らない。1 つの事実に複数の出典があれば \`^[1]^[2]\` と並べる
- 見出し (#) は使わない。**\`## 関連メディア\` は書かない** (機械が後ろに足す)。
  frontmatter やタイトルも書かない
- 既存記事へのリンクは \`[[記事タイトル]]\` (表示を変えるなら \`[[記事タイトル|表示]]\`)。
  **リンクしてよいのは「既存記事のタイトル」に挙げたものだけ。** 無いタイトルを作らない
- 本人の特徴的な言い回しは「」で短く引いてよい (「とっても可愛い」程度)。
  長い引用はしない。ブログの文章をそのまま貼らず、事実に言い換える
- **短くてよい。** 素材が少なければ箇条書き 1〜2 行で終える。行を埋めるために足さない

## 書かないこと

- **タイトルの物以外の話題。** ブログは本文が丸ごと入っているが、使うのはこの物の段落だけ
- **投稿したこと自体。** 「トークで写真を公開した」「ブログを更新した」は事実の行にしない。
  トークやブログは出典 (\`^[n]\`) として使うだけ
- **画像・動画の中身。** 素材の本文・説明・メモに書かれたことだけ書く。本文の無いトークは中身が見えない。
  色・形・写っているものを想像で書かない
- **商品情報の補足。** 品名・ブランド・値段などは素材に書かれているものだけ

${EDITORIAL_RULES}

## 出力

JSON で返す。
- body: 本文 (Markdown)。上の形に従う
- tags: 「既存のタグ」から 0〜4 個。**関係するメンバー名 + カテゴリ** (ぬいぐるみ など)。
  出典の種類や時期を表すタグ (ninatalk / ブログ / 2026年 など) は付けない。タイトルそのものはタグにしない
- date: 素材の投稿日のうち、この物が話に出た最も早い日 "YYYY-MM-DD"。本文の「今日」「昨日」で動かさない。
  投稿日が分からず月だけ分かるなら**その月の 1 日** (例: 2025年8月なら "2025-08-01")。月も分からなければ null
- dateDisplay: 記事に出す日付の表記。"2026年2月" のように月まで。その月の 1 日にしたときや、もらった・
  買った時期が分からず話に出た時期しか言えないときは "2025年6月頃" と「頃」を付ける。何も分からなければ null
- title: null (記事のタイトルはドシエのタイトルを使う)

## 見本 (既存記事。この形に揃える)

${SAMPLES.map(
  (s) => `### 「${s.title}」 (date: ${s.date}, dateDisplay: ${s.dateDisplay}, tags: ${s.tags.join(", ")})\n${s.body}`
).join("\n\n")}
`;

export function itemSystemPrompt(context: AiContext): string[] {
  return aiSystemPrompt(RULES, context);
}

export function itemPrompt(input: DossierRenderInput, context: AiContext): AiPrompt {
  const materials = buildMaterialsText(input);
  return {
    system: itemSystemPrompt(context),
    user: [
      `記事のタイトル (= まとめる物): ${input.dossier.title}`,
      "",
      "以下の素材から、この物について分かる事実だけを本文にしてください。",
      "",
      materials.text,
    ].join("\n"),
    included: materials.included,
    truncated: materials.truncated,
  };
}

export function renderItemArticle(input: DossierRenderInput, draft?: AiDraft | null): RenderedArticle {
  const { blogs, talks } = classifyMaterials(input.assets);
  const { sources, talkSourceNo } = numberSources(blogs, talks);
  // 関連メディアに載せるのは画像・動画のトークだけ (文章のトークは出典としてだけ使う。おでかけと同じ)
  const mediaTalks = talks.filter((a) => a.kind !== "text");

  // 本文が空なら「下書き無し」と同じ (骨組みだけにする)。AI が関連メディアしか書かなかったときも空になる
  const written = draft ? stripRelatedMedia(normalizeAiBody(draft.body, sources.length)).trimEnd() : "";
  const used = written ? draft : null;
  const links = (input.links ?? []).map((l) => ({
    url: l.url,
    card: linkCard(l.url, l.caption.trim() || input.dossier.title),
  }));
  const body: string[] = [
    ...(input.thumbnailUrl ? [`<img src="${input.thumbnailUrl}" alt="${input.dossier.title.replace(/"/g, "”")} サムネイル" width="600">`, ""] : []),
    written || ITEM_BODY_PLACEHOLDER,
    "",
    ...renderLinksSection(links.map((l) => l.card)),
    ...renderRelatedMediaSection({ talks: mediaTalks, blogs, tiktoks: input.tiktoks, talkSourceNo, style: ITEM_MEDIA_STYLE }),
  ];

  return {
    title: input.dossier.title,
    tags: used ? normalizeAiTags(used.tags) : [],
    body: joinBody(body),
    sources,
    // 引用の章は無い (地の文は AI / 人が持つ)。購入リンクと関連メディアだけ追記の対象
    parts: {
      ...buildParts({ quoted: [], reports: [], tiktoks: input.tiktoks, talks: mediaTalks, blogs, talkSourceNo }),
      links,
    },
    dates: {
      date: used?.date ?? null,
      dateDisplay: used?.dateDisplay ?? null,
      dateMode: null,
    },
    draft: true,
    frontmatterExtra: {
      dossier: dossierSnapshot(input.dossier, input.today),
      ...(input.thumbnailUrl ? { thumbnail: input.thumbnailUrl } : {}),
    },
  };
}

export const ITEM_TEMPLATE: ArticleTemplateDef = {
  key: "item",
  articleType: "item",
  needsAi: true,
  appendLayout: { ...AI_BODY_APPEND_LAYOUT, media: ITEM_MEDIA_STYLE },
  render: renderItemArticle,
  prompt: itemPrompt,
  defaultRules: RULES,
};
