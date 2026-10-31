"use client";

import { useEffect, useRef } from "react";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  keymap,
  placeholder as placeholderExt,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  autocompletion,
  completionKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import {
  findWikiLinkQuery,
  rankWikiLinkCandidates,
  wikiLinkInsertion,
  type WikiLinkCandidate,
} from "@/lib/articles/wiki-link-complete";
import { ARTICLE_FLAG_LABELS, ARTICLE_TYPE_LABELS, cn } from "@/lib/utils";

/**
 * 記事本文の Markdown エディタ (#318)。CodeMirror 6。
 *
 * - 値は Markdown の文字列のまま。送信は親の hidden input が持つ (ここは name を持たない)
 * - 色付けは見出し・強調・リンクに加えて、記事独自の `[[記事]]` と脚注 `^[n]`
 * - `[[` を打つと記事タイトルを補完する。記号を隠す Live Preview 風の表示はしない
 */
export function MarkdownEditor({
  value,
  onChange,
  disabled,
  candidates,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  candidates: WikiLinkCandidate[];
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  // 拡張は 1 回しか作らないので、最新の値は ref 越しに読む
  const onChangeRef = useRef(onChange);
  const candidatesRef = useRef(candidates);
  /** 直近に onChange で親へ渡した値。親から戻ってきた古い値で上書きしないために持つ */
  const lastSent = useRef(value);
  useEffect(() => {
    onChangeRef.current = onChange;
    candidatesRef.current = candidates;
  });

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(highlightStyle),
          articleMarks,
          autocompletion({
            override: [(ctx) => wikiLinkSource(ctx, candidatesRef.current)],
            icons: false,
          }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "本文" }),
          placeholderExt("本文 (Markdown)。[[ で記事へのリンク"),
          editable.current.of(EditorView.editable.of(!disabled)),
          EditorView.updateListener.of((u: ViewUpdate) => {
            if (!u.docChanged) return;
            lastSent.current = u.state.doc.toString();
            onChangeRef.current(lastSent.current);
          }),
          theme,
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 初期化は 1 回だけ。以降の value / disabled は下の effect で反映する
  }, []);

  // 外から値が変わったとき (入力由来でない変更) だけ差し替える。
  // 自分が渡した値が遅れて戻ってきただけなら触らない (日本語入力中に 1 文字消えるのを防ぐ)
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === lastSent.current) return;
    lastSent.current = value;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(!disabled)) });
  }, [disabled]);

  return (
    <div
      ref={hostRef}
      className={cn(
        // 高さはエディタの起動前から確保する (後から伸びて下の欄がずれないように)
        "min-h-[60vh] border border-slate-300 rounded bg-white focus-within:ring-2 focus-within:ring-blue-500",
        disabled && "bg-slate-50",
        className,
      )}
    />
  );
}

function wikiLinkSource(ctx: CompletionContext, candidates: WikiLinkCandidate[]): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const found = findWikiLinkQuery(line.text.slice(0, ctx.pos - line.from));
  if (!found) return null;
  const options: Completion[] = rankWikiLinkCandidates(candidates, found.query).map((c) => ({
    label: c.title,
    detail: [c.type ? ARTICLE_TYPE_LABELS[c.type] : null, c.draft ? ARTICLE_FLAG_LABELS.draft : null, c.unlisted ? ARTICLE_FLAG_LABELS.unlisted : null]
      .filter(Boolean)
      .join(" ・ "),
    apply: (view, _completion, from, to) => {
      const { insert, consumeAfter } = wikiLinkInsertion(c.title, view.state.sliceDoc(to, view.state.doc.lineAt(to).to));
      view.dispatch({
        changes: { from, to: to + consumeAfter, insert },
        selection: { anchor: from + insert.length },
        userEvent: "input.complete",
      });
    },
  }));
  return {
    from: line.from + found.from,
    options,
    // 並べ替えは自前でしているので CodeMirror のあいまい一致は使わない
    filter: false,
  };
}

/** `[[記事]]` と脚注 `^[n]` に印を付ける (Markdown の文法には無いので正規表現で) */
const articleMarkDecorator = new MatchDecorator({
  regexp: /\[\[[^\[\]\n]+\]\]|\^\[\d+\]/g,
  decoration: (m) => (m[0].startsWith("[[") ? wikiLinkMark : footnoteMark),
});
const wikiLinkMark = Decoration.mark({ class: "cm-wiki-link" });
const footnoteMark = Decoration.mark({ class: "cm-footnote-ref" });

const articleMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = articleMarkDecorator.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = articleMarkDecorator.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

const highlightStyle = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: "700", fontSize: "1.25em", color: "#0f172a" },
  { tag: tags.heading2, fontWeight: "700", fontSize: "1.15em", color: "#0f172a" },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: "700", color: "#0f172a" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "#2563eb" },
  { tag: tags.quote, color: "#475569" },
  { tag: tags.monospace, color: "#9333ea" },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.meta], color: "#94a3b8" },
]);

const theme = EditorView.theme({
  "&": { fontSize: "0.875rem", minHeight: "60vh" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    lineHeight: "1.625",
    minHeight: "60vh",
  },
  ".cm-content": { padding: "0.375rem 0.75rem" },
  ".cm-line": { padding: "0" },
  ".cm-wiki-link": { color: "#2563eb", backgroundColor: "#eff6ff", borderRadius: "2px" },
  ".cm-footnote-ref": { color: "#64748b" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "inherit", maxHeight: "16rem" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "0.25rem 0.5rem" },
  ".cm-completionDetail": { marginLeft: "0.75rem", color: "#94a3b8", fontStyle: "normal", fontSize: "0.75rem" },
});
