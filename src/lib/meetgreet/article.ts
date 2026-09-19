/**
 * ミーグリ記事の本文組み立て (#109)。
 *
 * `sekai-nina-site/.claude/skills/dossier-to-meetgreet-article/generate.py` の移植。
 * 実戦で固まった変換ルール（出典での分類・採番順・ひなたぼっこ日記の扱い）をそのまま持ち込む。
 * **DB に触らない純粋関数**なので、既存の公開記事と突き合わせて忠実性を検証できる。
 *
 * 呼び出し側 (`src/lib/domain/meetgreet-article.ts`) がドシエと X レポから入力を組み立てる。
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
}

export interface RenderArticleInput {
  /** 開催日 (JST "YYYY-MM-DD") */
  date: string;
  format: "online" | "real";
  /** リアルのときタイトルに出す会場名 */
  venue?: string | null;
  single?: string | null;
  /** ドシエのアセット (asset_ref のアイテム由来) */
  assets: ArticleAssetInput[];
  /** ファンのレポ (X の URL)。呼び出し側が並び順と重複を解決して渡す */
  reports: string[];
  /** TikTok の URL */
  tiktoks: string[];
  /** サムネ画像の URL (スケッチ or ドシエの「サムネ」) */
  thumbnailUrl: string | null;
  /** frontmatter の dossier スナップショット用 */
  dossier: { id: string; updatedAt: string; itemCount: number };
  /** published_at / updated_at / synced_at に入れる JST の今日 */
  today: string;
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

export interface RenderedArticle {
  title: string;
  tags: string[];
  body: string;
  sources: RenderedSource[];
  parts: ArticleParts;
  /** frontmatterExtra に入れる dossier / meetgreet */
  frontmatterExtra: {
    dossier: { id: string; updated_at: string; item_count: number; synced_at: string };
    meetgreet: { single?: string; format: string; outfit_image?: string };
  };
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
function mediaLabel(kind: AssetKind): string {
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
function isTalk(a: ArticleAssetInput): boolean {
  const src = a.source;
  if (!src) return a.title.includes("トーク");
  if (src.kind === "other") return true;
  if ((src.title ?? "").startsWith("Talk")) return true;
  if (!src.url && a.title.includes("トーク")) return true;
  return false;
}

interface BlogGroup {
  url: string | null;
  title: string;
  date: string;
  staff: boolean;
  excerpts: string[];
  /** 出典が指すアセット (本文 text。無ければ先頭画像) */
  ref: string | null;
  images: ArticleAssetInput[];
  sourceNo: number;
}

/** ブログ / トークに振り分け、ブログは URL ごとにまとめる */
function classify(assets: ArticleAssetInput[]): { blogs: BlogGroup[]; talks: ArticleAssetInput[] } {
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
function blogLabel(b: BlogGroup): string {
  if (b.staff && !b.title.includes(STAFF_BLOG_NAME)) return `${STAFF_BLOG_NAME}「${b.title}」`;
  return b.title;
}

/**
 * 記事タイトル。
 * - オンライン: `2026年8月9日 オンラインミーグリ`
 * - リアル: `2026年8月1日 リアルミーグリ（京都）` — 会場が分かるときだけ括弧を付ける
 *
 * **ファイル名 = タイトル**なので、規則を変えると URL が変わる。既存記事の改名はしない。
 */
export function articleTitleFor(input: {
  date: string;
  format: "online" | "real";
  venue?: string | null;
}): string {
  const kind = input.format === "online" ? "オンラインミーグリ" : "リアルミーグリ";
  const venue = input.venue?.trim();
  const suffix = input.format === "real" && venue ? `（${venue}）` : "";
  return `${jpDate(input.date)} ${kind}${suffix}`;
}

/** 記事の本文と出典を組み立てる */
export function renderMeetGreetArticle(input: RenderArticleInput): RenderedArticle {
  const online = input.format === "online";
  // 地の文・alt は略さない正式表記、タイトルは短縮形
  const kindFull = online ? "オンラインミート＆グリート" : "リアルミート＆グリート";
  const title = articleTitleFor(input);
  const titleFull = `${jpDate(input.date)} ${kindFull}`;
  const tags = online ? ["オンラインミーグリ", "ミーグリ"] : ["リアルミーグリ", "ミーグリ"];

  const { blogs, talks } = classify(input.assets);
  const blogsWithImages = blogs.filter((b) => b.images.length > 0);

  // 出典の採番: ブログ (日付昇順) → トーク (時系列)
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

  const body: string[] = [];

  // 1. サムネ (記事トップ)
  if (input.thumbnailUrl) {
    body.push(`<img src="${input.thumbnailUrl}" alt="${titleFull} サムネイル" width="600">`, "");
  }

  // 2. イントロ (地の文では略称を使わない)
  // 会場はタイトルにだけ出す。地の文に入れるかは記事によって割れており
  // (2026年6月13日 は入れ、2026年8月1日 は入れていない)、直近の形に合わせる
  body.push(
    `${jpDate(input.date)}、${kindFull}が開催された。坂井新奈が参加し、後日のブログやTalkでその様子を振り返っている。`,
    ""
  );

  // 3. 本人の感想 (ひなたぼっこ日記の抜粋は本人の言葉ではないので載せない)
  const quoted = blogs.filter((b) => b.excerpts.length > 0 && !b.staff);
  if (quoted.length > 0) {
    body.push("## 本人の感想（ブログより）", "");
    for (const b of quoted) {
      for (const ex of b.excerpts) {
        // 取り込んだブログ本文は CRLF のことがある。そのまま引用すると行末に \r が残る
        body.push(
          ex
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .map((ln) => (ln ? `> ${ln}` : ">"))
            .join("\n"),
          ""
        );
      }
      // 引用が複数あっても出典行はブログごとに 1 回だけ
      body[body.length - 1] = `*引用: [${blogLabel(b)}（${b.date}）](${b.url})*^[${b.sourceNo}]`;
      body.push("");
    }
  }

  // 4. ファンによるミーグリレポ (サイトの JS が X の URL を埋め込みに変換する)
  if (input.reports.length > 0) {
    body.push("## ファンによるミーグリレポ", "", "ファンが投稿したミート＆グリートの感想（X）。", "");
    body.push(...input.reports.map((u) => `![](${u})`));
    body.push("");
  }

  // 5. 関連メディア (トーク・ブログ画像はリンクのみ、TikTok は埋め込み)
  if (talks.length > 0 || blogsWithImages.length > 0 || input.tiktoks.length > 0) {
    body.push("## 関連メディア", "");
    if (input.tiktoks.length > 0) {
      // 埋め込みで目を引くので先頭に置く
      body.push("### TikTok", "");
      body.push(...input.tiktoks.map((u) => `![](${u})`));
      body.push("");
    }
    if (talks.length > 0) {
      body.push("### トーク", "");
      for (const a of talks) {
        body.push(`- 【トーク・${mediaLabel(a.kind)}】${a.title}^[${talkSourceNo.get(a.id)}]`);
      }
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
        const kind = b.staff ? STAFF_BLOG_NAME : "ブログ";
        for (const a of b.images) body.push(`- 【${kind}・画像】${a.title}^[${b.sourceNo}]`);
      }
      body.push("");
    }
  }

  const meetgreet: RenderedArticle["frontmatterExtra"]["meetgreet"] = {
    // frontmatter は「対面」表記 (タイトルの「リアル」とは別)
    format: online ? "オンライン" : "対面",
  };
  if (input.single?.trim()) meetgreet.single = input.single.trim();
  if (input.thumbnailUrl) meetgreet.outfit_image = input.thumbnailUrl;

  const parts: ArticleParts = {
    quotes: quoted.map((b) => ({
      sourceNo: b.sourceNo,
      label: blogLabel(b),
      url: b.url,
      date: b.date,
      excerpts: b.excerpts.map((ex) => ex.replace(/\r\n?/g, "\n")),
    })),
    reports: input.reports,
    tiktoks: input.tiktoks,
    talks: talks.map((a) => ({
      assetId: a.id,
      line: `- 【トーク・${mediaLabel(a.kind)}】${a.title}^[${talkSourceNo.get(a.id)}]`,
      sortAt: a.sortAt,
    })),
    blogImages: blogsWithImages.flatMap((b) =>
      b.images.map((a) => ({
        assetId: a.id,
        line: `- 【${b.staff ? STAFF_BLOG_NAME : "ブログ"}・画像】${a.title}^[${b.sourceNo}]`,
      }))
    ),
  };

  return {
    title,
    tags,
    body: body.join("\n").replace(/\n+$/, "") + "\n",
    sources,
    parts,
    frontmatterExtra: {
      dossier: {
        id: input.dossier.id,
        updated_at: input.dossier.updatedAt,
        item_count: input.dossier.itemCount,
        synced_at: input.today,
      },
      meetgreet,
    },
  };
}
