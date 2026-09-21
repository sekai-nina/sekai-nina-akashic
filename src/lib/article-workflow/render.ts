/**
 * 記事の組み立ての共通コア (#169 / #170)。
 *
 * ミーグリ記事の組み立て (`src/lib/meetgreet/article.ts`、#109) からテンプレートに依らない部分を
 * 切り出したもの。ドシエの素材をブログ / トークに振り分け、出典に番号を振り、
 * 「本人の感想」「ファンのレポ」「関連メディア」の章を出す。テンプレート
 * (`src/lib/article-workflow/templates/`) はこれを組み合わせて記事にする。
 *
 * **DB に触らない純粋関数。** 出力の形はミーグリ記事の実戦ルールそのままで、
 * `src/lib/meetgreet/article.test.ts` が守っている。
 */

import type { AssetKind } from "@prisma/client";

/** 運営ブログの正式名称。本人ブログと区別してこの名前で出す */
export const STAFF_BLOG_NAME = "ひなたぼっこ日記";

/** 本人ブログは /diary/detail/<id>、ひなたぼっこ日記は /diary/manager/... で来る */
export function isStaffBlog(url: string | null | undefined): boolean {
  return (url ?? "").includes("/diary/manager");
}

export interface ArticleAssetInput {
  id: string;
  kind: AssetKind;
  title: string;
  /** JST の暦日 "YYYY-MM-DD"。出典の date に出る */
  canonicalDate: string | null;
  /**
   * 並べ替え用の時刻つきの値 (ISO)。
   * **日付だけで並べるとトークの順序が崩れる** (同じ日に複数あるのが普通なので、
   * 日付だけだと同着になって入力順に落ちる)。
   */
  sortAt: string | null;
  /** 先頭の出典 */
  source: { kind: string; title: string; url: string | null; publishedAt: string | null } | null;
  /** 抜粋 (本人の感想)。同じアセットから複数あることがある */
  excerpts: string[];
  /**
   * AI に渡す素材 (#171)。本文を AI が書くテンプレートのときだけ読み込む (`withTexts`)。
   * `text` はブログ / トークの本文全文 (body / message_body)。`caption` はドシエのアイテムの
   * キャプション、`people` はアセットに付いた人物エンティティ名
   */
  text?: string | null;
  caption?: string;
  people?: string[];
}

export interface RenderedSource {
  sourceNo: number;
  label: string;
  url: string | null;
  /** "YYYY-MM-DD" */
  date: string | null;
  /** 出典が指すアセット */
  assetId: string | null;
}

/** 本文に出る項目の内訳。追記モードが「まだ無いもの」を選ぶのに使う */
export interface ArticleParts {
  /** 本人の感想。ブログごとにまとめた引用 */
  quotes: { sourceNo: number; label: string; url: string | null; date: string; excerpts: string[] }[];
  /** ファンのレポ (X の URL) */
  reports: string[];
  tiktoks: string[];
  /** 関連メディアのトーク */
  talks: { assetId: string; line: string; sortAt: string | null }[];
  /** 関連メディアのブログ画像 */
  blogImages: { assetId: string; line: string }[];
}

/** frontmatter の `dossier:` (由来ドシエのスナップショット。「要反映」の判定に使う) */
export interface DossierSnapshot {
  id: string;
  updated_at: string;
  item_count: number;
  synced_at: string;
}

/**
 * 記事の本文に載る日付まわり。テンプレートが決める
 * (ミーグリは開催日、ブログの名言は無し、スナップは無し、おでかけ / 状況つきの言葉は AI の提案)。
 * null は frontmatter に出さない
 */
export interface RenderedDates {
  /** "YYYY-MM-DD" */
  date: string | null;
  dateDisplay: string | null;
  /** null / "single" / "range" */
  dateMode: string | null;
}

export interface RenderedArticle<Extra extends Record<string, unknown> = Record<string, unknown>> {
  title: string;
  tags: string[];
  body: string;
  sources: RenderedSource[];
  parts: ArticleParts;
  dates: RenderedDates;
  /** 新規作成時の下書きフラグ。機械で完成する型は false、AI が書いた本文は人が見るまで true */
  draft: boolean;
  /** frontmatterExtra に入れる dossier とテンプレート固有のブロック (meetgreet / live / locations …) */
  frontmatterExtra: { dossier: DossierSnapshot } & Extra;
}

/**
 * X の URL を比べるための正規化 (クエリ・末尾スラッシュ・www・twitter.com の揺れを吸収)。
 * **組み立てと追記で同じ規則を使うこと。** 別々に持つと、片方が拾えない表記
 * (例: www.x.com) のレポを毎回「新規」と判定して重複追記する。
 */
export function normalizeTweetUrl(url: string): string {
  return url
    .trim()
    .split("?")[0]
    .replace(/\/+$/, "")
    .replace(/^https?:\/\/(?:www\.)?(?:twitter|x)\.com\//, "https://x.com/");
}

/**
 * 出典 URL を比べるための正規化。
 *
 * **フラグメントを落とさないこと。** ひなたぼっこ日記は
 * `…/diary/manager/list?ima=0000#article-70538` の形で、`#article-NNNNN` だけが
 * 記事を識別する。クエリごと切ると全投稿が同じ URL に潰れ、別の回の画像が
 * 前の投稿の脚注に紐づく。ツイート用の normalizeTweetUrl を流用してはいけない。
 */
export function normalizeSourceUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** "2026-08-01" → "2026年8月1日" */
export function jpDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${y}年${Number(m)}月${Number(d)}日`;
}

/** asset.kind → 日本語のメディア種別 */
export function mediaLabel(kind: AssetKind): string {
  return kind === "video" ? "動画" : kind === "image" ? "画像" : kind === "audio" ? "音声" : "メディア";
}

/** ブログ画像のタイトル "… (n/m)" から n を取り出す。無ければ 0 (先頭) */
function imageOrder(title: string): number {
  const m = title.match(/\((\d+)\/\d+\)/);
  return m ? Number(m[1]) : 0;
}

/**
 * トークか。**asset.kind では判定しない** (トークのスクショは image で来るので、
 * kind で分けるとブログ画像に化ける)。出典で見る。
 */
export function isTalk(a: ArticleAssetInput): boolean {
  const src = a.source;
  if (!src) return a.title.includes("トーク");
  if (src.kind === "other") return true;
  if ((src.title ?? "").startsWith("Talk")) return true;
  if (!src.url && a.title.includes("トーク")) return true;
  return false;
}

/** `坂井新奈ブログ「…」` / `高井俐香ブログ「…」` の形か (取り込みが付けるアセットの題) */
export function isBlogAssetTitle(title: string): boolean {
  return /^.+?ブログ「.*」\s*$/.test(title);
}

/** 1 本のブログ (本文 + 画像 + 抜粋) */
export interface BlogGroup {
  url: string | null;
  title: string;
  date: string;
  staff: boolean;
  excerpts: string[];
  /** 出典が指すアセット (本文 text。無ければ先頭画像) */
  ref: string | null;
  images: ArticleAssetInput[];
  /** `numberSources` が振る。それまでは 0 */
  sourceNo: number;
}

/** ブログ / トークに振り分け、ブログは URL ごとにまとめる */
export function classifyMaterials(assets: ArticleAssetInput[]): {
  blogs: BlogGroup[];
  talks: ArticleAssetInput[];
} {
  const blogs = new Map<string, BlogGroup>();
  const talks: ArticleAssetInput[] = [];

  for (const a of assets) {
    if (isTalk(a)) {
      talks.push(a);
      continue;
    }
    const url = a.source?.url ?? a.id;
    const group = blogs.get(url) ?? {
      url: a.source?.url ?? null,
      title: a.source?.title || a.title,
      date: (a.source?.publishedAt ?? a.canonicalDate ?? "").slice(0, 10),
      staff: isStaffBlog(a.source?.url),
      excerpts: [],
      ref: null,
      images: [],
      sourceNo: 0,
    };
    if (a.kind === "text") {
      group.ref = a.id;
      // 出典のタイトルは古い取り込みだと素のブログ題 (「自分を変える」) で、誰のブログか分からない。
      // アセットの題が「〜ブログ「…」」の形ならそちらを出典ラベルにする (既存記事の frontmatter と同じ形)
      // ひなたぼっこ日記は `blogLabel` が名前を付けるので触らない (二重に包まない)
      if (!group.staff && isBlogAssetTitle(a.title)) group.title = a.title;
      // 同じブログから複数箇所を抜粋していることがある (全部拾う)
      for (const ex of a.excerpts) if (ex && !group.excerpts.includes(ex)) group.excerpts.push(ex);
    } else {
      group.images.push(a);
    }
    blogs.set(url, group);
  }

  // 時刻まで見て並べる (同じ日のトークの前後を保つ)
  talks.sort((x, y) => (x.sortAt ?? "").localeCompare(y.sortAt ?? ""));
  const list = [...blogs.values()].sort((x, y) => x.date.localeCompare(y.date));
  for (const b of list) {
    b.images.sort((x, y) => imageOrder(x.title) - imageOrder(y.title));
    // text が無いブログ (画像だけ) は先頭画像を ref にする
    if (!b.ref && b.images.length > 0) b.ref = b.images[0].id;
  }
  return { blogs: list, talks };
}

/** 出典ラベル。ひなたぼっこ日記は誰のブログか分かるよう明示する */
export function blogLabel(b: BlogGroup): string {
  if (b.staff && !b.title.includes(STAFF_BLOG_NAME)) return `${STAFF_BLOG_NAME}「${b.title}」`;
  return b.title;
}

/**
 * 出典の採番: ブログ (日付昇順) → トーク (時系列)。
 * ブログには `sourceNo` を書き込み、トークは ID → 番号の対応を返す
 */
export function numberSources(
  blogs: BlogGroup[],
  talks: ArticleAssetInput[]
): { sources: RenderedSource[]; talkSourceNo: Map<string, number> } {
  const sources: RenderedSource[] = [];
  let sid = 1;
  for (const b of blogs) {
    b.sourceNo = sid;
    sources.push({
      sourceNo: sid,
      url: b.url,
      label: blogLabel(b),
      date: b.date || null,
      assetId: b.ref,
    });
    sid++;
  }
  const talkSourceNo = new Map<string, number>();
  for (const a of talks) {
    sources.push({
      sourceNo: sid,
      url: null,
      label: a.title,
      date: (a.canonicalDate ?? "").slice(0, 10) || null,
      assetId: a.id,
    });
    talkSourceNo.set(a.id, sid);
    sid++;
  }
  return { sources, talkSourceNo };
}

/** 引用ブロック。取り込んだブログ本文は CRLF のことがあり、そのまま引用すると行末に \r が残る */
export function blockquote(excerpt: string): string {
  return excerpt
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((ln) => (ln ? `> ${ln}` : ">"))
    .join("\n");
}

/** 本人の感想 (引用) にする対象。ひなたぼっこ日記の抜粋は本人の言葉ではないので載せない */
export function quotedBlogs(blogs: BlogGroup[]): BlogGroup[] {
  return blogs.filter((b) => b.excerpts.length > 0 && !b.staff);
}

/** `## 本人の感想（ブログより）` の章。引用が無ければ空 */
export function renderQuotesSection(quoted: BlogGroup[]): string[] {
  if (quoted.length === 0) return [];
  const body: string[] = ["## 本人の感想（ブログより）", ""];
  for (const b of quoted) {
    for (const ex of b.excerpts) body.push(blockquote(ex), "");
    // 引用が複数あっても出典行はブログごとに 1 回だけ
    body[body.length - 1] = `*引用: [${blogLabel(b)}（${b.date}）](${b.url})*^[${b.sourceNo}]`;
    body.push("");
  }
  return body;
}

/** ファンのレポの章 (サイトの JS が X の URL を埋め込みに変換する)。見出しと導入文は器ごとに違う */
export function renderReportsSection(
  reports: string[],
  layout: { heading: string; lead: string }
): string[] {
  if (reports.length === 0) return [];
  return [layout.heading, "", layout.lead, "", ...reports.map((u) => `![](${u})`), ""];
}

/** トークの行 (関連メディア)。追記の突き合わせにも使うので 1 箇所で作る */
function talkLine(a: ArticleAssetInput, sourceNo: number | undefined): string {
  return `- 【トーク・${mediaLabel(a.kind)}】${a.title}^[${sourceNo}]`;
}

/** ブログ画像の行 (関連メディア) */
function blogImageLine(b: BlogGroup, a: ArticleAssetInput): string {
  return `- 【${b.staff ? STAFF_BLOG_NAME : "ブログ"}・画像】${a.title}^[${b.sourceNo}]`;
}

/**
 * 関連メディアの章の形。
 * - `sections`: ミーグリ記事の形。`### TikTok` / `### トーク` / `### ブログ（画像）` に分ける
 * - `flat`: おでかけ記事の形。導入文 1 行のあと、トーク → ブログ画像を 1 つの箇条書きに並べる
 */
export type RelatedMediaStyle = { kind: "sections" } | { kind: "flat"; lead: string };

/** `## 関連メディア` の章 (トーク・ブログ画像はリンクのみ、TikTok は埋め込み)。何も無ければ空 */
export function renderRelatedMediaSection(input: {
  talks: ArticleAssetInput[];
  blogs: BlogGroup[];
  tiktoks: string[];
  talkSourceNo: Map<string, number>;
  style?: RelatedMediaStyle;
}): string[] {
  const blogsWithImages = input.blogs.filter((b) => b.images.length > 0);
  if (input.talks.length === 0 && blogsWithImages.length === 0 && input.tiktoks.length === 0) return [];
  const style = input.style ?? { kind: "sections" };
  if (style.kind === "flat") {
    const body: string[] = ["## 関連メディア", "", style.lead, ""];
    body.push(...input.tiktoks.map((u) => `![](${u})`));
    for (const a of input.talks) body.push(talkLine(a, input.talkSourceNo.get(a.id)));
    for (const b of blogsWithImages) for (const a of b.images) body.push(blogImageLine(b, a));
    body.push("");
    return body;
  }
  const body: string[] = ["## 関連メディア", ""];
  if (input.tiktoks.length > 0) {
    // 埋め込みで目を引くので先頭に置く
    body.push("### TikTok", "");
    body.push(...input.tiktoks.map((u) => `![](${u})`));
    body.push("");
  }
  if (input.talks.length > 0) {
    body.push("### トーク", "");
    for (const a of input.talks) body.push(talkLine(a, input.talkSourceNo.get(a.id)));
    body.push("");
  }
  if (blogsWithImages.length > 0) {
    body.push("### ブログ（画像）", "");
    body.push(
      blogsWithImages.some((b) => !b.staff)
        ? "坂井新奈のブログには、当日前後の写真が掲載されている。"
        : `${STAFF_BLOG_NAME}に、当日前後の写真が掲載されている。`
    );
    body.push("");
    for (const b of blogsWithImages) {
      for (const a of b.images) body.push(blogImageLine(b, a));
    }
    body.push("");
  }
  return body;
}

/** 追記モードが使う内訳 (`planAppend`)。本文と同じ行の形で持つ */
export function buildParts(input: {
  quoted: BlogGroup[];
  reports: string[];
  tiktoks: string[];
  talks: ArticleAssetInput[];
  blogs: BlogGroup[];
  talkSourceNo: Map<string, number>;
}): ArticleParts {
  return {
    quotes: input.quoted.map((b) => ({
      sourceNo: b.sourceNo,
      label: blogLabel(b),
      url: b.url,
      date: b.date,
      excerpts: b.excerpts.map((ex) => ex.replace(/\r\n?/g, "\n")),
    })),
    reports: input.reports,
    tiktoks: input.tiktoks,
    talks: input.talks.map((a) => ({
      assetId: a.id,
      line: talkLine(a, input.talkSourceNo.get(a.id)),
      sortAt: a.sortAt,
    })),
    blogImages: input.blogs
      .filter((b) => b.images.length > 0)
      .flatMap((b) => b.images.map((a) => ({ assetId: a.id, line: blogImageLine(b, a) }))),
  };
}

export function dossierSnapshot(
  dossier: { id: string; updatedAt: string; itemCount: number },
  today: string
): DossierSnapshot {
  return {
    id: dossier.id,
    updated_at: dossier.updatedAt,
    item_count: dossier.itemCount,
    synced_at: today,
  };
}

/** 本文の行を 1 つの文字列にする (末尾の空行は 1 つの改行に揃える) */
export function joinBody(lines: string[]): string {
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}
