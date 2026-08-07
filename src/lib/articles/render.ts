import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";

import { remarkCardLink } from "./remark/cardlink";
import { remarkObsidianCallouts } from "./remark/obsidian-callouts";
import { remarkFigureCaption } from "./remark/figure-caption";
import { remarkQuoteMarkers } from "./remark/quote-markers";
import { remarkFootnoteRefs } from "./remark/footnote-refs";
import { remarkTweets } from "./remark/tweets";
import { remarkWikilinks } from "./remark/wikilinks";

/**
 * 記事本文の Markdown を HTML にする。
 *
 * sekai-nina-site (astro.config.mjs) と同じプラグイン構成・同じ順序にしてある。
 * 順序を変えると出力が変わる (例: remarkBreaks を先に通すとコールアウトの
 * ブロック判定が崩れる) ので、公開サイト側を触ったらこちらも合わせること。
 *
 * 自作プラグインは {type:'html'} の生ノードを吐くため、rehype 側で
 * rehype-raw を通さないと素通りしてエスケープされる。
 */
function buildProcessor(resolveWikilink: (title: string) => string | undefined) {
  return unified()
    .use(remarkParse)
    .use(remarkMath)
    .use(remarkCardLink)
    .use(remarkObsidianCallouts)
    .use(remarkFigureCaption)
    .use(remarkBreaks)
    .use(remarkQuoteMarkers)
    // akashic 独自: ^[n] を出典一覧へのアンカーにする
    .use(remarkFootnoteRefs)
    // akashic 独自: X の画像記法を埋め込み用 blockquote にする
    .use(remarkTweets)
    // akashic 独自: [[記事名]] を記事へのリンクにする
    .use(remarkWikilinks(resolveWikilink))
    // allowDangerousHtml: 自作プラグインの生 HTML ノードを hast まで運ぶ
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeKatex)
    .use(rehypeStringify, { allowDangerousHtml: true });
}

export interface RenderOptions {
  /** 記事タイトル -> shortId。wikilink の解決に使う */
  wikilinks?: Map<string, string>;
}

export async function renderArticleBody(
  markdown: string,
  opts: RenderOptions = {},
): Promise<string> {
  const processor = buildProcessor((title) => opts.wikilinks?.get(title));
  const file = await processor.process(markdown);
  return String(file);
}
