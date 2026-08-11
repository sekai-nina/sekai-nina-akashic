import { defaultSchema } from "rehype-sanitize";
import type { Options as SanitizeSchema } from "rehype-sanitize";

/**
 * 記事本文のサニタイズ設定。
 *
 * パイプラインは自作プラグインが `{type:'html'}` の生ノードを吐くため rehype-raw を
 * 通しており、そのままだと **記事 Markdown 中の生 HTML も一緒に通る**。入力が自リポジトリの
 * Markdown だけなら信頼できるが、#46 で外部の AI エージェントが記事を書けるようにすると
 * その前提が崩れる。
 *
 * akashic では XSS の被害が大きい:
 * - Supabase の認証 cookie は `@supabase/ssr` のブラウザクライアントが `document.cookie` で
 *   読む設計なので **httpOnly ではなく、XSS がそのままセッション奪取になる**
 * - 奪取後に読めるのは clearance で保護された Asset 群
 *
 * **適用位置は `rehypeRaw` の直後・`rehypeKatex` の前。** KaTeX は数式から大量の class を
 * 動的に生成するので、それを許可リストで追いかけるのは脆い。サニタイズ済みの
 * `<span class="math math-inline">` を渡してから KaTeX に展開させれば、生成物は
 * 自前のコード由来なのでサニタイズ不要になる。
 *
 * 許可リストに漏れがあると**表示が壊れる**ので、変更したら全記事のレンダリング検証を回すこと。
 */

/** 自作プラグインと remark-math が付ける class */
const ALLOWED_CLASSES = [
  // cardlink.ts
  "cardlink", "cardlink-content", "cardlink-image", "cardlink-meta",
  "cardlink-title", "cardlink-description", "cardlink-host", "cardlink-favicon",
  // figure-caption.ts
  "article-figure", "figure-caption",
  // footnote-refs.ts
  "footnote-ref",
  // obsidian-callouts.ts (callout-<type> は動的なので個別に足す)
  "callout", "callout-content", "callout-title",
  // 折りたたみ形式 (> [!note]- のように - が付くもの)
  "callout-toggle", "callout-toggle-title", "callout-toggle-content",
  "callout-note", "callout-tip", "callout-info", "callout-warning", "callout-danger",
  "callout-success", "callout-question", "callout-quote", "callout-example",
  "callout-abstract", "callout-todo", "callout-failure", "callout-bug",
  // table-wrapper.ts
  "table-wrapper",
  // tweets.ts
  "twitter-tweet",
  // wikilinks.ts
  "wikilink", "wikilink-missing",
  // remark-math → rehype-katex の受け渡し用マーカー
  "math", "math-inline", "math-display",
];

/**
 * class の許可ルール。
 *
 * `defaultSchema` は `attributes["*"]` に className を含めず、代わりに
 * `attributes.a` に `["className", "data-footnote-backref"]` という**タグ固有の制限**を
 * 持つ。タグ固有の指定があるとそちらが優先されるため、`*` 側でいくら許可しても
 * `<a class="wikilink">` は `class=""` に潰される。className を使うタグには
 * 明示的にこのルールを入れること。
 */
const CLASS_RULE: [string, ...string[]] = [
  "className",
  ...ALLOWED_CLASSES,
  "data-footnote-backref", // defaultSchema.attributes.a が元から許可しているもの
];

/** defaultSchema 由来の className ルールを外す (CLASS_RULE で置き換えるため) */
function withoutClassRule(attrs: readonly unknown[] | undefined): unknown[] {
  return (attrs ?? []).filter((x) => !(Array.isArray(x) && x[0] === "className"));
}

export const articleSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,

  // href / src で許可するプロトコル。remark-rehype はプロトコル検査をしないため、
  // これが無いと `[click](javascript:alert(1))` がそのまま href に載る
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },

  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "details",   // コールアウトの折りたたみ
    "summary",
    "figure",    // 図と説明
    "figcaption",
  ],

  attributes: {
    ...defaultSchema.attributes,
    "*": [...withoutClassRule(defaultSchema.attributes?.["*"]), CLASS_RULE],
    a: [
      ...withoutClassRule(defaultSchema.attributes?.a),
      CLASS_RULE,
      "target",
      "rel",
      "title",
      "dataSourceNo", // footnote-refs.ts が出典番号を持たせる
    ],
    img: [...withoutClassRule(defaultSchema.attributes?.img), CLASS_RULE, "loading"],
    details: [CLASS_RULE, "open"],
    span: [CLASS_RULE, "title"],
    div: [...withoutClassRule(defaultSchema.attributes?.div), CLASS_RULE],
    blockquote: [...withoutClassRule(defaultSchema.attributes?.blockquote), CLASS_RULE, "cite"],
    figure: [CLASS_RULE],
    figcaption: [CLASS_RULE],
    sup: [CLASS_RULE],
    table: [...withoutClassRule(defaultSchema.attributes?.table), CLASS_RULE],
  } as SanitizeSchema["attributes"],
};

export { ALLOWED_CLASSES };
