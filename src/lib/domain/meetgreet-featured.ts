/**
 * ミーグリページに出すファンレポの選択 (#210)。
 *
 * 選択の正は記事本文の `![rep](…)` マーカー (`src/lib/meetgreet/featured-reports.ts`)。
 * ここは「記事に載っているレポをツイートの中身つきで並べる」「マーカーを付け外しする」
 * 「サイトと同じ拾い方で、今サイトに出る 9 件を出す」を持つ。
 *
 * 本文の書き換えは `patchArticle` を通す (UI の保存と同じ楽観ロック・正規化・dirty の立て方)。
 * 反映は記事の push で、push するまでサイトは変わらない。
 *
 * `Article` は非保護テーブルなので素の `prisma`。ツイートの中身 (`RepoTweet`) は保護テーブルなので
 * `withClearance` で引き、見えないものは URL だけで出す。
 */

import { prisma, withClearance } from "@/lib/db";
import { toJstDateOnly } from "@/lib/utils";
import {
  featuredReportUrls,
  listReportEmbeds,
  setReportFeatured,
  SITE_FEATURED_REPORTS_LIMIT,
  tweetIdOf,
} from "@/lib/meetgreet/featured-reports";
import { patchArticle } from "./articles";
import { MeetGreetInputError, type ActingUser } from "./meetgreets";

/** サイトがミーグリ記事を見分けるタグ (sekai-nina-site の `MEETGREET_TAG`) */
const MEETGREET_TAG = "ミーグリ";

/** 一覧に出す件数。サイトに出る 9 件の後ろに、次に押し出されるものを少しだけ見せる */
const SITE_REPORTS_SHOWN = SITE_FEATURED_REPORTS_LIMIT + 3;

interface TweetInfo {
  authorName: string;
  authorUsername: string;
  text: string;
}

/** tweetId → 中身。見えない (収集の機密レベルが上) ものは入らない */
async function loadTweets(clearance: string, tweetIds: string[]): Promise<Map<string, TweetInfo>> {
  const ids = [...new Set(tweetIds)];
  if (ids.length === 0) return new Map();
  const rows = await withClearance(clearance, (tx) =>
    tx.repoTweet.findMany({
      where: { tweetId: { in: ids } },
      select: { tweetId: true, authorName: true, authorUsername: true, text: true },
    })
  );
  return new Map(rows.map((r) => [r.tweetId, r]));
}

export interface ArticleReport {
  tweetId: string;
  url: string;
  featured: boolean;
  tweet: TweetInfo | null;
}

export interface MeetGreetArticleReports {
  shortId: string;
  /** push 待ち (= サイトはまだ前の状態) */
  dirty: boolean;
  reports: ArticleReport[];
}

/** その回の記事に載っているレポ。記事がまだ無ければ null */
export async function listArticleReports(
  user: ActingUser,
  articleId: string | null
): Promise<MeetGreetArticleReports | null> {
  if (!articleId) return null;
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { shortId: true, body: true, dirty: true },
  });
  if (!article) return null;
  const embeds = listReportEmbeds(article.body);
  const tweets = await loadTweets(user.clearance, embeds.map((e) => e.tweetId));
  return {
    shortId: article.shortId,
    dirty: article.dirty,
    reports: embeds.map((e) => ({ ...e, tweet: tweets.get(e.tweetId) ?? null })),
  };
}

/**
 * レポの `![rep]` を付け外しする。記事は dirty になり、次の push でサイトに出る。
 * 記事が他で保存された直後でも取りこぼさないよう、最新の updatedAt で書く
 * (この操作は 1 行の付け替えなので、読んだ直後の本文に当てれば他の編集を壊さない)
 */
export async function setMeetGreetReportFeatured(
  user: ActingUser,
  meetGreetId: string,
  tweetId: string,
  on: boolean
): Promise<void> {
  const mg = await withClearance(user.clearance, (tx) =>
    tx.meetGreet.findUnique({ where: { id: meetGreetId }, select: { articleId: true } })
  );
  if (!mg) throw new MeetGreetInputError("見つかりません");
  if (!mg.articleId) throw new MeetGreetInputError("まだ記事がありません");

  // 読んでから書くまでに別の保存が入ったら 1 回だけ読み直す
  for (let attempt = 0; attempt < 2; attempt++) {
    const article = await prisma.article.findUnique({
      where: { id: mg.articleId },
      select: { shortId: true, body: true, updatedAt: true },
    });
    if (!article) throw new MeetGreetInputError("記事が見つかりません");
    const body = setReportFeatured(article.body, tweetId, on);
    if (body === null) throw new MeetGreetInputError("このレポは記事に載っていません (記事を開き直してください)");
    if (body === article.body) return;

    const res = await patchArticle(article.shortId, article.updatedAt, { body }, { id: user.id });
    if (res.ok) return;
    if (res.reason === "conflict") continue;
    throw new MeetGreetInputError(res.reason === "not_found" ? "記事が見つかりません" : "本文を保存できませんでした");
  }
  throw new MeetGreetInputError("記事が同時に編集されています。開き直してください");
}

export interface SiteReport {
  tweetId: string | null;
  url: string;
  /** サイトに出る (先頭 9 件) か、その次に控えているか */
  shown: boolean;
  articleShortId: string;
  articleTitle: string;
  articleDirty: boolean;
  /** 開催日 (記事の date, JST) */
  date: string | null;
  meetGreetId: string | null;
  tweet: TweetInfo | null;
}

/**
 * サイトの `collectReports` と同じ拾い方で、ミーグリ記事の `![rep]` を新しい記事から並べる。
 * **DB の本文で数える**ので、push 待ちの記事は「push 後に出るもの」になる (`articleDirty` で分かる)。
 */
export async function listSiteFeaturedReports(user: ActingUser): Promise<SiteReport[]> {
  // 出典 (`ArticleSource`) は保護テーブル。素の `prisma` だと include が無言で空になるので withClearance で引く
  const rows = await withClearance(user.clearance, (tx) =>
    tx.article.findMany({
      where: { tags: { array_contains: [MEETGREET_TAG] }, draft: false, unlisted: false },
      select: {
        id: true,
        shortId: true,
        path: true,
        title: true,
        body: true,
        date: true,
        dirty: true,
        // date が無い記事は、サイトが frontmatter の出典の最も古い日付を使う (`getArticleDate`)。
        // frontmatter に載るのは pending 以外かつ public の出典だけ
        sources: {
          where: { status: { not: "pending" }, classification: "public", date: { not: null } },
          select: { date: true },
          orderBy: { date: "asc" },
          take: 1,
        },
      },
    })
  );
  const articles = rows.map((a) => ({ ...a, sortDate: toJstDateOnly(a.date ?? a.sources[0]?.date ?? null) ?? "" }));
  // サイトは日付の新しい順の安定ソート。同じ日はコレクションの並び (path 順) のまま残る
  articles.sort((a, b) => b.sortDate.localeCompare(a.sortDate) || a.path.localeCompare(b.path));

  const picked: Omit<SiteReport, "shown" | "tweet" | "meetGreetId">[] = [];
  for (const a of articles) {
    for (const url of featuredReportUrls(a.body)) {
      picked.push({
        tweetId: tweetIdOf(url),
        url,
        articleShortId: a.shortId,
        articleTitle: a.title,
        articleDirty: a.dirty,
        date: a.sortDate || null,
      });
      if (picked.length >= SITE_REPORTS_SHOWN) break;
    }
    if (picked.length >= SITE_REPORTS_SHOWN) break;
  }

  const articleIds = articles.filter((a) => picked.some((p) => p.articleShortId === a.shortId)).map((a) => a.id);
  const [tweets, meetGreets] = await Promise.all([
    loadTweets(user.clearance, picked.flatMap((p) => (p.tweetId ? [p.tweetId] : []))),
    withClearance(user.clearance, (tx) =>
      tx.meetGreet.findMany({ where: { articleId: { in: articleIds } }, select: { id: true, articleId: true } })
    ),
  ]);
  const mgByArticle = new Map(meetGreets.map((m) => [m.articleId, m.id]));
  const idByShortId = new Map(articles.map((a) => [a.shortId, a.id]));

  return picked.map((p, i) => ({
    ...p,
    shown: i < SITE_FEATURED_REPORTS_LIMIT,
    meetGreetId: mgByArticle.get(idByShortId.get(p.articleShortId) ?? "") ?? null,
    tweet: p.tweetId ? (tweets.get(p.tweetId) ?? null) : null,
  }));
}
