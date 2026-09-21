/**
 * おでかけ (outing) 記事のテンプレート (#172)。
 *
 * 坂井新奈が同期メンバー等と出かけた出来事を、ブログ / トークの言及から**事実の地の文 + 箇条書き**に
 * まとめる `type: event` の記事。sekai-nina-site の `dossier-to-outing-article` スキル
 * (`outing_brief.py`) の移植:
 *
 * - 本文 (AI): 冒頭 1〜2 文 (いつ・誰と・何をしたか) → 場所 / 行動ごとの `##` + 事実の箇条書き `^[n]`。
 *   引用しない
 * - `## 関連メディア` (機械): 画像・動画のトークとブログ画像をリンクで、TikTok を埋め込みで、1 つの箇条書きに (flat)。
 *   文章のトークは出典にだけ使う
 * - `locations` (機械): 場所候補。聖地に昇格済みなら `place_id`、未昇格なら座標をインライン
 * - `date` / `date_display` / tags は AI の提案 (同行者 + カテゴリ)
 *
 * 見本は既存記事 2 本 (理想形の江ノ島デートと、短いひとりパフェ)。
 */

import { buildMaterialsText } from "../materials";
import {
  buildParts,
  classifyMaterials,
  dossierSnapshot,
  joinBody,
  numberSources,
  renderRelatedMediaSection,
  type RelatedMediaStyle,
  type RenderedArticle,
} from "../render";
import { aiSystemPrompt, EDITORIAL_RULES, NO_QUOTES_APPEND_LAYOUT, normalizeAiBody, normalizeAiTags } from "./shared";
import type { AiContext, AiDraft, AiPrompt, ArticleTemplateDef, DossierPlace, DossierRenderInput } from "./types";

/** AI が使えなかったときに本文に置くプレースホルダ。記事編集画面で人が置き換える */
export const OUTING_BODY_PLACEHOLDER =
  "<!-- 本文: AI が使えなかったので、素材を読んで書いてください。冒頭 1〜2 文 + 場所 / 行動ごとの ## と事実の箇条書き、各事実に ^[n] で出典。引用はしない -->";

/** 関連メディアの導入文 (`outing_brief.py` と同じ) */
export const OUTING_MEDIA_LEAD = "坂井新奈が写っている、このおでかけに関する記録。";
const OUTING_MEDIA_STYLE: RelatedMediaStyle = { kind: "flat", lead: OUTING_MEDIA_LEAD };

interface OutingSample {
  title: string;
  date: string;
  dateDisplay: string;
  tags: string[];
  body: string;
}

/**
 * 見本にする既存記事 (公開済み)。文体・粒度・章立て・出典の付け方を揃えるために見せる。
 * 江ノ島デートは外部サイト (食べログ / 水族館の案内) へのリンク行 2 本だけ落としてある
 * (「URL は場所候補にあるものだけ」の規則と食い違うため)。それ以外は原文どおり
 */
const SAMPLES: OutingSample[] = [
  {
    title: "蔵盛妃那乃と江ノ島デート",
    date: "2025-08-01",
    dateDisplay: "2025年8月頃",
    tags: [],
    body: `2025年8月頃、坂井新奈と蔵盛妃那乃は江ノ島にてデートをした。本記事では蔵盛妃那乃のブログを基に、時系列順にその内容についてまとめる。蔵盛曰く、「計画がほぼ全部上手く行かなくずっと笑っていた」デートだったらしく^[3]、坂井新奈も「江ノ島デート私たち可哀想だったけど本当に楽しかったよ!!」と述べている^[4]。

## 集合

- 集合場所をお互い間違えた^[2]

## 海鮮丼

- 海鮮丼を食べた^[2]
\t- [べたなぎ](https://maps.app.goo.gl/PgKVp8eahvDULgSW7)という店である
\t- 蔵盛妃那乃が食べていたのは[ブログ](https://www.hinatazaka46.com/s/official/diary/detail/65414)の写真から「べたなぎ丼」であると推測できるが、坂井新奈が何を頼んだのかは不明

## 金魚すくい

- 海鮮丼屋の近くに金魚すくいがあり、写真を撮り合った^[2]
\t- [江ノ島金魚](https://maps.app.goo.gl/5VB4F3VpSF5LZxzj7)という店で、金魚を持ち帰らなくても良い店
\t- おそらく金魚すくいをしている様子をお互いに撮り合ったということだろう

## 海

- 海に向かったが暴風で髪の毛が荒ぶってしまい上手く写真が撮れなかった^[2]

## 水族館

- 切り替えて水族館へ行った^[2]
\t- これは[新江ノ島水族館](https://maps.app.goo.gl/JS9uDQJiPmctAAmK7)である
\t- イルカショーを見た^[2]
\t\t- 人が多くて埋もれていた^[2]
\t- クラゲを見た^[2]
\t- 触れ合いコーナーもぎりぎり間に合わなかった^[2]
\t\t- ナマコやヒトデに触れるはずだったらしい^[2]
\t- 体験コーナーではちょうど前の人で終わって驚いた^[2]
\t\t- これは何の体験コーナーなのかは不明
\t- 水族館レストランも3分間に合わなかった^[2]
- 水族館を出る頃には店が閉まっていたので、ゆったり探索して帰った^[2]

## シャボン玉

- シャボン玉で遊んだ^[2]
\t- 電動でシャボン玉が出る装置でシャボン玉を出しながら、お互いに写真を撮り合っている^[1]^[2]`,
  },
  {
    title: "ひとりパフェ",
    date: "2026-07-04",
    dateDisplay: "2026年7月",
    tags: ["飲食店"],
    body: `2026年7月4日、坂井新奈は初めて一人でパフェを食べることに挑戦した^[1]^[2]。本記事では坂井新奈のTalkでの言及をもとにまとめる。

## ひとりパフェ

- この日はリハーサルがあり、パフェを食べてリハーサルを頑張ろうとしていた^[1]
- 初めて一人でパフェを食べることに挑戦した^[2]
\t- 訪れたのは[果実園リーベル 目黒店](https://maps.google.com/?cid=488658104780264921)である
\t- 初めての一人パフェで、結構大人になったような気持ちになったという^[2]
- 後日（7月11日）、この日のひとりパフェの写真を自撮りしたものをTalkで公開した^[3]`,
  },
];

const RULES = `あなたは日向坂46・坂井新奈のアーカイブサイト「世界新奈」の編集者です。
ドシエ (素材の束) を読んで、「おでかけ」記事の本文を書きます。おでかけ記事とは、坂井新奈が
同期メンバー等と出かけた (食事・レジャー・映画・旅行など) 出来事を、ブログ / トークの言及から
**事実だけを淡々と**まとめた \`type: event\` の記事です。

## 本文の形

- **冒頭 1〜2 文**: いつ・誰と・何をしたかを言い切る (例: 「2026年5月、坂井新奈はレッスン終わりに
  同期の大田美月とパンケーキを食べに行った^[3]。」)。続けて「本記事では〜のブログやTalkでの言及を
  もとにまとめる。」のように出典の種類を 1 文で
- 続けて **場所 / 行動ごとに \`##\` の見出し**を立て、その下に \`- \` の箇条書きで事実を並べる。
  1 項目 1 事実。細部・補足・推測は tab でネストする
- **各事実の末尾に出典を \`^[n]\` で付ける。** n は素材に書いてある番号をそのまま使う。
  番号の無い出典を作らない。複数あれば \`^[1]^[2]\`
- **引用はしない。** 本人や相手の言葉をそのまま載せず、事実に言い換える
  (「ホイップたっぷり・いちご添えのパンケーキが1皿5枚」のように)。冒頭の 1 文で本人の
  総括的な一言 (「本当に楽しかった」) を「」で短く引くのは可
- 場所は「場所候補」にあるものを本文でも \`[店名](Google マップの URL)\` でリンクしてよい
  (URL は場所候補にあるものだけ。作らない)
- 推測を書くなら「〜と思われる」「〜かもしれない」「不明」と明示する。断定しない
- **\`## 関連メディア\` は書かない** (機械が後ろに足す)。frontmatter やタイトルも書かない
- 既存記事へのリンクは \`[[記事タイトル]]\`。**「既存記事のタイトル」に挙げたものだけ**

${EDITORIAL_RULES}

## 出力

JSON で返す。
- body: 本文 (Markdown)。上の形に従う
- tags: 「既存のタグ」から 0〜4 個。**一緒に出かけた人物名 + カテゴリ** (飲食店 / レジャー / 映画 /
  ディズニー / クリスマス など)。出典の種類や時期を表すタグ (ninatalk / ブログ / 2026年 など) は付けない
- date: 出来事の日 "YYYY-MM-DD"。素材の日付 (ブログ / トークの投稿日) と本文の「今日」「昨日」等から
  決める。日が分からなければ**その月の 1 日** (例: 2025年8月なら "2025-08-01")。月も分からなければ null
- dateDisplay: 記事に出す日付の表記。"2026年7月" のように月まで (日が確かでもこの形でよい)。
  日が分からず月の 1 日にしたときは "2025年8月頃" と「頃」を付ける。何も分からなければ null
- title: null (記事のタイトルはドシエのタイトルを使う)

## 見本 (既存記事。この形に揃える)

${SAMPLES.map(
  (s) =>
    `### 「${s.title}」 (date: ${s.date}, dateDisplay: ${s.dateDisplay}, tags: ${s.tags.length ? s.tags.join(", ") : "なし"})\n${s.body}`
).join("\n\n")}
`;

export function outingSystemPrompt(context: AiContext): string[] {
  return aiSystemPrompt(RULES, context);
}

/**
 * 場所候補をプロンプトに。渡すのは名前・住所・Google マップ URL だけ (`outing_brief.py` と同じ)。
 * 編集メモ (`note`) は「本人の自宅近く」のような内部の注意書きが入りうるので**渡さない**
 */
function placesText(places: DossierPlace[]): string {
  if (places.length === 0) return "";
  const lines = ["## 場所候補 (本文で `[名前](URL)` とリンクしてよい。聖地か座標があるものは locations にも入る)", ""];
  for (const p of places) {
    const bits = [p.name];
    if (p.address) bits.push(p.address);
    if (p.googleMapsUrl) bits.push(p.googleMapsUrl);
    lines.push(`- ${bits.join(" / ")}`);
  }
  return lines.join("\n") + "\n";
}

export function outingPrompt(input: DossierRenderInput, context: AiContext): AiPrompt {
  const materials = buildMaterialsText(input);
  return {
    system: outingSystemPrompt(context),
    user: [
      `記事のタイトル (= 出来事): ${input.dossier.title}`,
      "",
      "以下の素材から、この出来事を事実だけで本文にしてください。",
      "",
      placesText(input.places),
      materials.text,
    ].join("\n"),
    included: materials.included,
    truncated: materials.truncated,
  };
}

/** frontmatter の `locations` (既存記事と同じキー名。`place_id` があれば座標は書かない) */
export function outingLocations(places: DossierPlace[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const p of places) {
    if (p.placeId) {
      out.push({ name: p.name, place_id: p.placeId });
      continue;
    }
    // 座標も place_id も無い候補は地図に出せない (サイトのスキーマが落とす)
    if (p.lat == null || p.lng == null) continue;
    const loc: Record<string, unknown> = { name: p.name, lat: p.lat, lng: p.lng };
    if (p.googleMapsUrl) loc.google_maps_url = p.googleMapsUrl;
    out.push(loc);
  }
  return out;
}

/** AI が指示に反して `## 関連メディア` を書いてきたら落とす (機械が同じ章を足すので二重になる) */
function stripRelatedMedia(body: string): string {
  const at = body.indexOf("\n## 関連メディア");
  return at >= 0 ? body.slice(0, at) : body.startsWith("## 関連メディア") ? "" : body;
}

export function renderOutingArticle(input: DossierRenderInput, draft?: AiDraft | null): RenderedArticle {
  const { blogs, talks } = classifyMaterials(input.assets);
  const { sources, talkSourceNo } = numberSources(blogs, talks);
  // 関連メディアに載せるのは画像・動画のトークだけ (文章のトークは出典としてだけ使う。`outing_brief.py` と同じ)
  const mediaTalks = talks.filter((a) => a.kind !== "text");

  const hasDraft = !!draft && draft.body.trim().length > 0;
  const body: string[] = [
    hasDraft ? stripRelatedMedia(normalizeAiBody(draft.body, sources.length)).trimEnd() : OUTING_BODY_PLACEHOLDER,
    "",
    ...renderRelatedMediaSection({ talks: mediaTalks, blogs, tiktoks: input.tiktoks, talkSourceNo, style: OUTING_MEDIA_STYLE }),
  ];
  const tags = hasDraft ? normalizeAiTags(draft.tags) : [];
  const locations = outingLocations(input.places);

  return {
    title: input.dossier.title,
    tags,
    body: joinBody(body),
    sources,
    // 引用の章は無い (地の文は AI / 人が持つ)。関連メディアだけ追記の対象
    parts: buildParts({ quoted: [], reports: [], tiktoks: input.tiktoks, talks: mediaTalks, blogs, talkSourceNo }),
    dates: {
      date: hasDraft ? draft.date : null,
      dateDisplay: hasDraft ? draft.dateDisplay : null,
      dateMode: null,
    },
    draft: true,
    frontmatterExtra: {
      dossier: dossierSnapshot(input.dossier, input.today),
      ...(locations.length > 0 ? { locations } : {}),
    },
  };
}

export const OUTING_TEMPLATE: ArticleTemplateDef = {
  key: "outing",
  articleType: "event",
  needsAi: true,
  appendLayout: { ...NO_QUOTES_APPEND_LAYOUT, media: OUTING_MEDIA_STYLE },
  render: renderOutingArticle,
  prompt: outingPrompt,
};
