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
 * - 場所のカード (AI が置き場所を決め、機械が展開): AI は場所候補の番号を `{{場所:K}}` の 1 行で
 *   その場所の `##` の末尾に置き、`expandPlaceCards` が Google マップへの `cardlink` ブロックにする
 *   (URL を AI に書き写させない)
 * - `locations` (機械): 場所候補。聖地に昇格済みなら `place_id`、未昇格なら座標をインライン
 *   (`place_id` の要素は保存時に ArticlePlace に移る。非公開の聖地は `placeIds` で紐づけだけ付く。#283)
 * - `date` / `date_display` / tags は AI の提案 (同行者 + カテゴリ)
 *
 * 見本は人が手直しした既存記事 3 本 (ちいかわ映画・餃子・パンケーキ)。
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
import { AI_BODY_APPEND_LAYOUT, aiSystemPrompt, EDITORIAL_RULES, normalizeAiBody, normalizeAiTags } from "./shared";
import type { AiContext, AiDraft, AiPrompt, ArticleTemplateDef, DossierPlace, DossierRenderInput } from "./types";

/** AI が使えなかったときに本文に置くプレースホルダ。記事編集画面で人が置き換える */
export const OUTING_BODY_PLACEHOLDER =
  "<!-- 本文: AI が使えなかったので、素材を読んで書いてください。冒頭 1〜2 文 + 場所 / 行動ごとの ## と事実の箇条書き、各事実に ^[n] で出典。引用はしない -->";

const OUTING_MEDIA_STYLE: RelatedMediaStyle = { kind: "flat" };

interface OutingSample {
  title: string;
  date: string;
  dateDisplay: string;
  tags: string[];
  body: string;
}

/**
 * 見本にする既存記事 (公開済み)。文体・粒度・章立て・出典の付け方を揃えるために見せる。
 * **2026-10-29 に企画から作り、人が手直しして公開した 3 本** (相手の感想・相手だけの行動・別の話題が
 * 入っていない)。AI には画像が見えないので、画像からしか分からない事実の行 (ちいかわの特典・
 * ジンジャーエール、パンケーキの「桃を丸ごと一個使った」) だけ落としてある。それ以外は原文どおり
 */
const SAMPLES: OutingSample[] = [
  {
    title: "映画『映画ちいかわ 人魚の島のひみつ』を金村美玖と観た",
    date: "2026-07-30",
    dateDisplay: "2026年7月",
    tags: ["映画", "先輩"],
    body: `2026年7月頃、坂井新奈は金村美玖に誘われて『映画ちいかわ 人魚の島のひみつ』を一緒に観に行った^[1]^[2]。本記事では金村美玖と坂井新奈それぞれのブログ、およびTalkでの言及をもとにまとめる。

## きっかけ

- 金村美玖は坂井新奈がちいかわ好きであることを知っていて、映画に誘った^[1]

## 映画

- 二人で『映画ちいかわ 人魚の島のひみつ』を観に行った^[1]^[2]
\t- 坂井新奈は、ちいかわを観ながら隣に金村美玖がいることを「なんて不思議なんだ〜」という気持ちになったと記している^[2]

## 上映後

- 映画が終わったあと、二人で2時間ほどちいかわについて語った^[1]
\t- 坂井新奈は、映画を観終わってからもちいかわについて沢山語らせてもらえたこと、ほかにも色んな話ができたことがとても嬉しかったと記している^[2]`,
  },
  {
    title: "石塚瑶季と餃子",
    date: "2026-08-14",
    dateDisplay: "2026年8月",
    tags: ["飲食店", "先輩"],
    body: `2026年8月、坂井新奈は先輩の石塚瑶季に餃子を食べに連れて行ってもらった^[1]。本記事では坂井新奈のブログでの言及をもとにまとめる。

## 餃子

- 石塚瑶季が坂井新奈を餃子に連れて行った^[1]
\t- 坂井新奈にとっては久しぶりの餃子で、とても美味しかったという^[1]
- 坂井新奈は、たくさん話を聞いてもらえたこと・声をかけてもらえたことが本当に嬉しかったと述べている^[1]`,
  },
  {
    title: "大田美月とパンケーキ・かき氷",
    date: "2026-08-01",
    dateDisplay: "2026年8月頃",
    tags: ["大田美月", "飲食店", "食べ物"],
    body: `2026年8月、坂井新奈は同期の大田美月とかき氷とパンケーキを食べに行った^[1]^[2]。本記事では坂井新奈のブログ・Talkをもとにまとめる。

## かき氷とパンケーキ

- 坂井新奈はかき氷を食べた^[3]^[7]
- また坂井新奈はパンケーキも食べた^[1]^[6]^[8]
\t- 坂井新奈はパンケーキについて「ふわふわ」「美味しかった」と述べている^[1]^[6]`,
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
  1 項目 1 事実。細部・補足は tab でネストする
- **各事実の末尾に出典を \`^[n]\` で付ける。** n は素材に書いてある番号をそのまま使う。
  番号の無い出典を作らない。複数あれば \`^[1]^[2]\`
- **引用はしない。** 本人や相手の言葉をそのまま載せず、事実に言い換える
  (「ホイップたっぷり・いちご添えのパンケーキが1皿5枚」のように)。冒頭の 1 文で本人の
  総括的な一言 (「本当に楽しかった」) を「」で短く引くのは可
- **場所のカード。** 「場所候補」に \`{{場所:K}}\` が付いている場所に行ったことが本文に出てきたら、
  その場所の \`##\` の**末尾 (箇条書きのあと) に \`{{場所:K}}\` だけの行**を空行で挟んで置く
  (機械が Google マップへのリンクカードに置き換える)。1 つの場所につき 1 回。行っていない場所・
  本文に出てこない場所のカードは置かない。URL やリンクを自分で書かない
- **短くてよい。** 素材が少なければ \`##\` 1 つ・箇条書き数行で終える。同じ事実を言い換えて
  繰り返さない。節を埋めるために行を足さない
- **\`## 関連メディア\` は書かない** (機械が後ろに足す)。frontmatter やタイトルも書かない
- 既存記事へのリンクは \`[[記事タイトル]]\`。**「既存記事のタイトル」に挙げたものだけ**

## 書かないこと (下書きを人が手直しするとき、毎回ここが削られている)

- **タイトルの出来事以外の話題。** ブログは本文が丸ごと入っているが、使うのはこの出来事の段落だけ。
  同じブログの別の話題 (サッカー観戦・ライブの感想・告知・今日の発見・別の日のおでかけ) は書かない
- **同行者だけの話。** 同行者が何を頼んだ・食べた・どう感じたか、映画や店への同行者の評価・考察、
  同行者の近況 (髪型・ハマっているもの・初めてのこと) は、同行者のブログに書いてあっても書かない。
  同行者のブログ / トークから拾うのは「坂井新奈と何をしたか」「坂井新奈について何を書いたか」だけ
  (例: 大田美月のブログの「私はイチゴのかき氷」「大きいクレープも食べた」は書かない。
  金村美玖のブログの「考えさせられる映画だった」は書かないが、「坂井新奈がちいかわ好きなのを
  知っていて誘った」は坂井新奈についての事実なので書く)
- **投稿したこと自体。** 「トークで写真を公開した」「ブログを更新した」「動画を送った」は事実の行に
  しない。トークやブログは出典 (\`^[n]\`) として使うだけ
- **推測と注釈の行。** 素材から分からないことを「〜と思われる」「〜かは不明」で埋めない。
  書かないと意味が通らないときだけ、明示して 1 行で
- **画像・動画の中身。** 本文の無いトークは中身が見えない。写っているもの・食べたものを想像で書かない

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

/** Google マップのリンク。候補の URL、無ければ座標、どちらも無ければ名前 + 住所で検索。住所も無ければ作らない */
function placeMapUrl(p: DossierPlace): string | null {
  if (p.googleMapsUrl) return p.googleMapsUrl;
  if (p.lat != null && p.lng != null) return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
  if (p.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.name} ${p.address}`)}`;
  return null;
}

/** カードを置ける場所候補 (`{{場所:K}}` の K は 1 始まり。`placesText` と `expandPlaceCards` で共通) */
function cardPlaces(places: DossierPlace[]): { no: number; place: DossierPlace; url: string }[] {
  const out: { no: number; place: DossierPlace; url: string }[] = [];
  for (const place of places) {
    const url = placeMapUrl(place);
    if (url) out.push({ no: out.length + 1, place, url });
  }
  return out;
}

/** カードの座標の行。座標の無い場所は無し (地図サムネイルの出ない、名前とホストだけのカードになる) */
function coordLines(place: DossierPlace): string[] {
  return place.lat != null && place.lng != null ? [`lat: ${place.lat}`, `lng: ${place.lng}`] : [];
}

/** `lat:` / `lng:` があるとカードに地点の地図サムネイルが出る (remark/cardlink.ts) */
function placeCard(place: DossierPlace, url: string): string {
  let host = "www.google.com";
  try {
    host = new URL(url).hostname;
  } catch {
    // 壊れた URL でもカードは出す (host は既定)
  }
  return ["```cardlink", `url: ${url}`, `title: "${place.name.replace(/"/g, "'")}"`, `host: ${host}`, ...coordLines(place), "```"].join(
    "\n",
  );
}

/**
 * 座標の行が無いころに置いた場所のカードへ `lat:` / `lng:` を足す (地図サムネイルを出すため)。
 * 同じ URL の場所のカードだけ。ほかの行と、カード以外の本文は触らない。`names` は足した場所
 */
export function addCardCoords(body: string, places: DossierPlace[]): { body: string; names: string[] } {
  const byUrl = new Map(cardPlaces(places).map((c) => [c.url, c.place]));
  const names: string[] = [];
  const out = body.replace(/^```cardlink\n((?:(?!```)[^\n]*\n)*?)```$/gm, (whole, inner: string) => {
    const url = inner.match(/^url:\s*(\S+)/m)?.[1];
    const place = url ? byUrl.get(url) : undefined;
    if (!place || /^(lat|lng):/m.test(inner)) return whole;
    const coords = coordLines(place);
    if (coords.length === 0) return whole;
    names.push(place.name);
    return `\`\`\`cardlink\n${inner}${coords.join("\n")}\n\`\`\``;
  });
  return { body: out, names };
}

const PLACE_MARKER = /^[ \t]*\{\{場所:(\d+)\}\}[ \t]*$/gm;

/**
 * AI が置いた `{{場所:K}}` の行を Google マップのリンクカードに置き換える。知らない番号の行と、
 * 本文にもうカードがある場所 (同じ URL の cardlink。追記の組み込みで二重にしない) の行は落とす
 */
export function expandPlaceCards(body: string, places: DossierPlace[]): string {
  const byNo = new Map(cardPlaces(places).map((c) => [c.no, c]));
  const placed = new Set<string>();
  for (const m of body.matchAll(/```cardlink\n(?:(?!```)[^\n]*\n)*?url:\s*(\S+)/g)) placed.add(m[1]);
  return body
    .replace(PLACE_MARKER, (_whole, k: string) => {
      const c = byNo.get(Number(k));
      if (!c || placed.has(c.url)) return "";
      placed.add(c.url);
      return placeCard(c.place, c.url);
    })
    .replace(/\n{3,}/g, "\n\n");
}

/** 本文の後ろに付く節。カードはこれより前に置く */
const TAIL_HEADING = /^## (関連メディア|補足|おまけ)\s*$/;

/**
 * 本文から場所を探す言い方。正式名、空白抜き、「前」「付近」を落とした名前 (「クイーンズスクエア前」)、
 * 先頭の語 (「鵬天閣 新館」→「鵬天閣」。英字だけの短い語は誤爆するので使わない)
 */
function placeKeys(name: string): string[] {
  const keys = new Set([name, name.replace(/\s+/g, "")]);
  const near = name.replace(/\s*(前|付近|周辺)$/, "");
  if (near !== name && near.length >= 2) keys.add(near);
  const head = name.split(/\s+/)[0];
  if (head !== name && (/[^\x00-\x7f]/.test(head) ? head.length >= 2 : head.length >= 5)) keys.add(head);
  return [...keys].map((k) => k.toLowerCase());
}

/**
 * ワークフローの外で書いた・#313 より前の記事に、場所のカードを後から置く (#324)。
 * 場所の名前が出てくる最初の `##` の末尾。出てこなければ訪問順で前後の場所と同じ節、どれも出てこなければ
 * 本文の最後 (`## 関連メディア` / `## 補足` / `## おまけ` の前)。
 * カードは `expandPlaceCards` と同じ形。同じ URL のカードが本文にあれば足さない。
 * `placements` は置いた場所と、その節の見出し (本文の最後に回したものは null)
 */
export function insertPlaceCards(
  body: string,
  places: DossierPlace[],
): { body: string; placements: { name: string; heading: string | null }[] } {
  const lines = body.split("\n");
  const headings: number[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("```")) inFence = !inFence;
    else if (!inFence && lines[i].startsWith("## ")) headings.push(i);
  }
  const tailAt = headings.find((i) => TAIL_HEADING.test(lines[i])) ?? lines.length;
  const sections = headings
    .filter((i) => i < tailAt)
    .map((start, n, arr) => {
      const end = arr[n + 1] ?? tailAt;
      return { heading: lines[start].slice(3).trim(), end, text: lines.slice(start, end).join("\n").toLowerCase() };
    });

  const placed = new Set([...body.matchAll(/```cardlink\n(?:(?!```)[^\n]*\n)*?url:\s*(\S+)/g)].map((m) => m[1]));
  /** 差し込む行番号 → カード (同じ行番号は場所の順) */
  const inserts = new Map<number, string[]>();
  const placements: { name: string; heading: string | null }[] = [];
  const all = cardPlaces(places);
  const hits = all.map((c) => sections.find((s) => placeKeys(c.place.name).some((k) => s.text.includes(k))));
  for (const [n, c] of all.entries()) {
    if (placed.has(c.url)) continue;
    placed.add(c.url);
    // 名前が出てこない場所 (「コロッケを食べた場所」等) は、訪問順で直前、無ければ直後の場所と同じ節
    const hit = hits[n] ?? hits.slice(0, n).findLast(Boolean) ?? hits.slice(n + 1).find(Boolean);
    const at = hit?.end ?? tailAt;
    inserts.set(at, [...(inserts.get(at) ?? []), placeCard(c.place, c.url)]);
    placements.push({ name: c.place.name, heading: hit?.heading ?? null });
  }
  if (inserts.size === 0) return { body, placements };

  // 差し込む所の前後にだけ空行を足す (本文のほかの空行は触らない。push の差分をカードだけにする)
  const out: string[] = [];
  for (let i = 0; i <= lines.length; i++) {
    for (const card of inserts.get(i) ?? []) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      out.push(card, "");
    }
    if (i < lines.length && !(lines[i] === "" && out[out.length - 1] === "" && inserts.has(i))) out.push(lines[i]);
  }
  return { body: out.join("\n"), placements };
}

/**
 * 場所候補をプロンプトに。渡すのは名前・住所だけ (`outing_brief.py` と同じ)。URL は渡さず、
 * カードを置ける場所に番号 (`{{場所:K}}`) を振る。
 * 編集メモ (`note`) は「本人の自宅近く」のような内部の注意書きが入りうるので**渡さない**
 */
export function placesText(places: DossierPlace[]): string {
  if (places.length === 0) return "";
  const cards = new Map(cardPlaces(places).map((c) => [c.place, c.no]));
  const lines = ["## 場所候補 (行った場所の `##` の末尾に `{{場所:K}}` を置くと、機械がリンクカードにする)", ""];
  for (const p of places) {
    const bits = [p.name];
    if (p.address) bits.push(p.address);
    const no = cards.get(p);
    lines.push(`- ${bits.join(" / ")}${no ? ` → \`{{場所:${no}}}\`` : " (カードなし)"}`);
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
    hasDraft
      ? expandPlaceCards(stripRelatedMedia(normalizeAiBody(draft.body, sources.length)), input.places).trimEnd()
      : OUTING_BODY_PLACEHOLDER,
    "",
    ...renderRelatedMediaSection({ talks: mediaTalks, blogs, tiktoks: input.tiktoks, talkSourceNo, style: OUTING_MEDIA_STYLE }),
  ];
  const tags = hasDraft ? normalizeAiTags(draft.tags) : [];
  const locations = outingLocations(input.places);
  const placeIds = input.linkedPlaceIds ?? input.places.flatMap((p) => (p.placeId ? [p.placeId] : []));

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
    ...(placeIds.length > 0 ? { placeIds } : {}),
  };
}

export const OUTING_TEMPLATE: ArticleTemplateDef = {
  key: "outing",
  articleType: "event",
  needsAi: true,
  appendLayout: { ...AI_BODY_APPEND_LAYOUT, media: OUTING_MEDIA_STYLE },
  render: renderOutingArticle,
  prompt: outingPrompt,
  defaultRules: RULES,
};
