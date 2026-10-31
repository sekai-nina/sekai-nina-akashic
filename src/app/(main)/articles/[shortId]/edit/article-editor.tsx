"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, Save } from "lucide-react";
import type { ArticleSourceStatus } from "@prisma/client";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ArticleEditFormValues } from "@/lib/articles/edit";
import {
  ARTICLE_DATE_MODE_LABELS,
  ARTICLE_FLAG_LABELS,
  ARTICLE_REVIEW_LABELS,
  ARTICLE_SOURCE_STATUS_LABELS,
  ARTICLE_TYPE_LABELS,
  cn,
  todayJst,
} from "@/lib/utils";
import { previewArticleAction, updateArticleAction, type ArticlePreview, type UpdateArticleState } from "./actions";
import { FootnoteAuditWarnings } from "../footnote-audit-warnings";
import { TagInput } from "./tag-input";
import { PlacePicker, type PlaceOption } from "./place-picker";
import { SourceViewer } from "./source-viewer";
import { MarkdownEditor, type MarkdownEditorHandle } from "./markdown-editor";
import { ArticlePanel } from "./article-panel";
import type { ArticleBacklink } from "@/lib/articles/related";
import { footnoteRefsInBody, nextSourceNo } from "@/lib/articles/footnotes";
import type { WikiLinkCandidate } from "@/lib/articles/wiki-link-complete";
import { isListArticle } from "@/lib/articles/list-article";

declare global {
  interface Window {
    /** X の widgets.js が生やす。埋め込みを後から差し込んだときに描画し直すのに使う */
    twttr?: { widgets: { load: (el?: HTMLElement) => void } };
  }
}

const TWITTER_WIDGETS_SRC = "https://platform.twitter.com/widgets.js";

interface SourceRef {
  id: string;
  sourceNo: number | null;
  status: ArticleSourceStatus;
  label: string;
}

const INPUT =
  "w-full border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50";
/** 他のフォーム (assets/[id]/edit 等) と同じラベルの見た目 */
const LABEL = "block text-sm font-medium text-slate-700 mb-1";

/**
 * 記事の編集フォーム。本文 (Markdown) が主役で、frontmatter は右の欄。
 *
 * - 入力はすべて制御コンポーネント。`<form action>` は完了時に非制御の欄を reset するので、
 *   保存に失敗 (楽観ロックの衝突など) したとき入力を残すため
 * - プレビューはタブ切替時に Server Action で 1 回だけ描画する (詳細と同じパイプライン)。
 *   本文のエディタはタブに依らずマウントしたままにする (編集中のカーソル・取り消し履歴を保つ)
 * - 保存は Server Action。成功すると詳細へ redirect されるのでここには戻らない
 */
export function ArticleEditor({
  shortId,
  updatedAt,
  initial,
  tagOptions,
  extraKeys,
  sources,
  initialPlaceIds,
  placeOptions,
  linkCandidates,
  initialRelated,
  backlinks,
  needsReview,
}: {
  shortId: string;
  /** 楽観ロック用。読み込んだ時点の Article.updatedAt (ISO) */
  updatedAt: string;
  initial: ArticleEditFormValues;
  tagOptions: string[];
  /** モデル外の frontmatter (触らせない。表示だけ) */
  extraKeys: string[];
  sources: SourceRef[];
  /** 紐づく聖地 (操作者に見える分、記事内の並び順) */
  initialPlaceIds: string[];
  /** 追加できる聖地 (操作者に見える全件) */
  placeOptions: PlaceOption[];
  /** 本文の `[[` で補完する記事 (この記事を除く全件) */
  linkCandidates: WikiLinkCandidate[];
  /** 関連記事 (frontmatter の related)。記事タイトルの並び */
  initialRelated: string[];
  /** この記事を参照している記事 (保存済みのタイトルで引いたもの) */
  backlinks: ArticleBacklink[];
  /** 「AI 書きたて (未確認)」か (#327) */
  needsReview: boolean;
}) {
  const [values, setValues] = useState(initial);
  const set = <K extends keyof ArticleEditFormValues>(key: K, v: ArticleEditFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  const [state, formAction, isSaving] = useActionState<UpdateArticleState, FormData>(
    updateArticleAction.bind(null, shortId),
    null,
  );

  const [placeIds, setPlaceIds] = useState(initialPlaceIds);
  const [related, setRelated] = useState(initialRelated);
  /** 「確認済みにする」を押したか (#327)。保存で印が外れる */
  const [reviewed, setReviewed] = useState(false);
  /** 記事パネルで予約した記事出典 (#320)。保存で確定する */
  const [reservedSources, setReservedSourcesState] = useState<{ shortId: string; title: string; sourceNo: number }[]>([]);
  const reservedRef = useRef(reservedSources);
  const setReservedSources = (next: typeof reservedSources | ((prev: typeof reservedSources) => typeof reservedSources)) => {
    reservedRef.current = typeof next === "function" ? next(reservedRef.current) : next;
    setReservedSourcesState(reservedRef.current);
  };
  /** 右の欄に出しているもの。出典 (id) か記事パネル。どちらでもなければ frontmatter の欄 */
  const [side, setSide] = useState<{ kind: "source"; id: string } | { kind: "articles" } | null>(null);
  const openSourceId = side?.kind === "source" ? side.id : null;
  const setOpenSourceId = (id: string | null) => setSide(id ? { kind: "source", id } : null);
  const editorRef = useRef<MarkdownEditorHandle>(null);

  // 離脱時の警告。初期値との比較は雑でよい (JSON で足りる)
  const changed =
    JSON.stringify(values) !== JSON.stringify(initial) ||
    JSON.stringify(placeIds) !== JSON.stringify(initialPlaceIds) ||
    JSON.stringify(related) !== JSON.stringify(initialRelated) ||
    reservedSources.length > 0 ||
    reviewed;
  useEffect(() => {
    if (!changed) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // 古い Chrome は preventDefault だけでは出ない
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [changed]);

  // --- プレビュー ---
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [preview, setPreview] = useState<ArticlePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewing, startPreview] = useTransition();
  const previewedBody = useRef<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  /** 直近に投げたプレビューの本文。古い応答が後から来ても採用しない */
  const requestedBody = useRef<string | null>(null);

  function showPreview() {
    setTab("preview");
    // 本文と予約中の記事出典が変わっていなければ使い回す
    const key = `${values.body}\u0000${reservedSources.map((r) => r.sourceNo).join(",")}`;
    if (previewedBody.current === key) return;
    const body = values.body;
    const reservedNos = reservedSources.map((r) => r.sourceNo);
    requestedBody.current = body;
    startPreview(async () => {
      try {
        const r = await previewArticleAction(shortId, body, reservedNos);
        if (requestedBody.current !== body) return; // その後に別の本文で投げ直している
        previewedBody.current = key;
        setPreview(r);
        setPreviewError(null);
      } catch (e) {
        if (requestedBody.current !== body) return;
        // 古い本文の描画を出したままにしない
        previewedBody.current = null;
        setPreview(null);
        setPreviewError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  // X の埋め込み。詳細ページは <script async> を素で置くが、ここは HTML が後から入るので
  // widgets.js を読み込んだうえで load() を呼び直す。
  // `setPreview` は await の後なので transition の外で commit され、isPreviewing が false に
  // なる commit とは別になる。描画先の div が付くのは後者なので、deps に isPreviewing も入れる
  const hasTweets = preview?.html.includes('class="twitter-tweet"') ?? false;
  useEffect(() => {
    if (tab !== "preview" || isPreviewing || !hasTweets || !previewRef.current) return;
    const el = previewRef.current;
    if (window.twttr) {
      window.twttr.widgets.load(el);
      return;
    }
    // 読み込み中にもう一度来ても script を重ねない
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TWITTER_WIDGETS_SRC}"]`);
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => window.twttr?.widgets.load(el), { once: true });
    if (!existing) {
      script.src = TWITTER_WIDGETS_SRC;
      script.async = true;
      script.charset = "utf-8";
      document.body.appendChild(script);
    }
  }, [tab, isPreviewing, hasTweets, preview]);

  const fieldError = (key: keyof ArticleEditFormValues) => state?.fieldErrors?.[key];

  return (
    <form
      action={formAction}
      className={cn(
        "grid grid-cols-1 gap-6 items-start",
        side?.kind === "source" ? "lg:grid-cols-[1fr_440px]" : side?.kind === "articles" ? "lg:grid-cols-[1fr_380px]" : "lg:grid-cols-[1fr_320px]"
      )}
    >
      <input type="hidden" name="updatedAt" value={updatedAt} />
      {reviewed && <input type="hidden" name="reviewed" value="1" />}
      {/* 関連記事 (#319)。パネルの開閉に依らず送る */}
      <input type="hidden" name="relatedField" value="1" />
      {related.map((t) => (
        <input key={t} type="hidden" name="related" value={t} />
      ))}
      {/* 記事出典の予約 (#320) */}
      <input
        type="hidden"
        name="articleSources"
        value={JSON.stringify(reservedSources.map(({ shortId: s, sourceNo }) => ({ shortId: s, sourceNo })))}
      />

      {/* 本文 */}
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2 mb-2">
          <Tabs value={tab} onValueChange={(v) => (v === "preview" ? showPreview() : setTab("edit"))}>
            <TabsList className="h-8">
              {/* form の中なので type="button" を明示する (既定の submit だと保存が走る) */}
              <TabsTrigger type="button" value="edit" className="text-xs py-1">
                編集
              </TabsTrigger>
              <TabsTrigger type="button" value="preview" className="text-xs py-1">
                {isPreviewing ? <Loader2 size={12} className="animate-spin mr-1" /> : null}
                プレビュー
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="text-xs text-slate-400 whitespace-nowrap">
            {values.body.length.toLocaleString("ja-JP")} 文字
          </span>
        </div>
        {fieldError("body") && <p className="text-xs text-red-600 mb-1">{fieldError("body")}</p>}

        {/* 送信はこの hidden input が持つ (エディタはタブに依らずマウントしたまま) */}
        <input type="hidden" name="body" value={values.body} />
        <MarkdownEditor
          value={values.body}
          onChange={(v) => set("body", v)}
          disabled={isSaving}
          candidates={linkCandidates}
          knownSourceNos={[
            ...sources.flatMap((x) => (x.sourceNo != null && x.status !== "pending" ? [x.sourceNo] : [])),
            ...reservedSources.map((x) => x.sourceNo),
          ]}
          className={cn(tab !== "edit" && "hidden")}
          ref={editorRef}
        />

        {tab === "preview" && (
          <div>
            {previewError && (
              <div className="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                プレビューに失敗しました: {previewError}
              </div>
            )}
            {preview && <FootnoteAuditWarnings audit={preview.audit} className="mb-2" />}
            <div className="bg-[#f8f7f4] border border-slate-200 rounded-lg p-5 min-h-[60vh]">
              {preview && !isPreviewing ? (
                <div
                  ref={previewRef}
                  className="article-content"
                  data-list-article={isListArticle(values.title) ? "" : undefined}
                  // 詳細ページと同じ。自リポジトリの記事 Markdown なので入力は信頼できる
                  dangerouslySetInnerHTML={{ __html: preview.html }}
                />
              ) : (
                <p className="text-sm text-slate-400">描画中…</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* frontmatter */}
      <aside className="space-y-4 lg:sticky lg:top-4">
        {openSourceId && (
          <SourceViewer
            shortId={shortId}
            sources={sources}
            openId={openSourceId}
            onOpen={setOpenSourceId}
            onClose={() => setOpenSourceId(null)}
          />
        )}
        {side?.kind === "articles" && (
          <ArticlePanel
            candidates={linkCandidates}
            related={related}
            onRelatedChange={setRelated}
            backlinks={backlinks}
            onInsert={(title) => {
              setTab("edit");
              editorRef.current?.insertAtCursor(`[[${title}]]`);
            }}
            onAddSource={(c) => {
              // 既存の出典・予約済み・本文の ^[n] の続きの番号を取る (保存時にも重なりを確かめる)
              // 続けて押されても同じ番号にならないよう、state ではなく ref の最新の予約で数える
              const sourceNo = nextSourceNo(
                [...sources.map((x) => x.sourceNo), ...reservedRef.current.map((x) => x.sourceNo)],
                values.body,
              );
              setReservedSources((prev) => [...prev, { shortId: c.shortId, title: c.title, sourceNo }]);
              setTab("edit");
              editorRef.current?.insertAtCursor(`^[${sourceNo}]`);
              return sourceNo;
            }}
            onClose={() => setSide(null)}
            disabled={isSaving}
          />
        )}
        {/* 出典・記事パネルを出している間は隠すだけ (外すと送信に入力が乗らない) */}
        <div className={cn("space-y-4", side && "hidden")}>
        {/* 記事のつながり (#319) */}
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h2 className="text-sm font-medium text-slate-700">記事のつながり</h2>
            <button
              type="button"
              onClick={() => setSide({ kind: "articles" })}
              className="shrink-0 px-2 py-1 rounded border border-slate-300 text-xs text-slate-600 hover:bg-slate-50"
            >
              記事パネルを開く
            </button>
          </div>
          <p className="text-xs text-slate-500">
            関連記事 {related.length} 件 ・ この記事を参照している記事 {backlinks.length} 件
          </p>
          {related.length > 0 && (
            <ol className="mt-1 text-xs text-slate-700 list-decimal list-inside">
              {related.map((t) => (
                <li key={t} className="truncate">
                  {t}
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
          <div>
            <label htmlFor="title" className={LABEL}>
              タイトル
            </label>
            <input
              id="title"
              name="title"
              type="text"
              value={values.title}
              onChange={(e) => set("title", e.target.value)}
              disabled={isSaving}
              className={INPUT}
            />
            {fieldError("title") && <p className="text-xs text-red-600 mt-1">{fieldError("title")}</p>}
            {values.title !== initial.title && (
              <p className="text-xs text-amber-700 mt-1">
                タイトルを変えると、他の記事の [[{initial.title}]] は宛先を失います
              </p>
            )}
          </div>

          <div>
            <label htmlFor="type" className={LABEL}>
              種別
            </label>
            <select
              id="type"
              name="type"
              value={values.type}
              onChange={(e) => set("type", e.target.value)}
              disabled={isSaving}
              className={INPUT}
            >
              <option value="">(未設定)</option>
              {Object.entries(ARTICLE_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {fieldError("type") && <p className="text-xs text-red-600 mt-1">{fieldError("type")}</p>}
          </div>

          <div>
            <label htmlFor="tags" className={LABEL}>
              タグ
            </label>
            <TagInput
              id="tags"
              name="tags"
              value={values.tags}
              onChange={(tags) => set("tags", tags)}
              options={tagOptions}
              disabled={isSaving}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="date" className={LABEL}>
                日付 (date)
              </label>
              <input
                id="date"
                name="date"
                type="date"
                value={values.date}
                onChange={(e) => set("date", e.target.value)}
                disabled={isSaving}
                className={INPUT}
              />
              {fieldError("date") && <p className="text-xs text-red-600 mt-1">{fieldError("date")}</p>}
            </div>
            <div>
              <label htmlFor="dateMode" className={LABEL}>
                日付の扱い
              </label>
              <select
                id="dateMode"
                name="dateMode"
                value={values.dateMode}
                onChange={(e) => set("dateMode", e.target.value)}
                disabled={isSaving}
                className={INPUT}
              >
                <option value="">(未設定)</option>
                {Object.entries(ARTICLE_DATE_MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
                {/* DB に enum 外の値が入っていたら、選択肢に無くて黙って消えないよう元の値も出す
                    (保存時の検証で弾かれるので、直すまで保存できない) */}
                {initial.dateMode && !(initial.dateMode in ARTICLE_DATE_MODE_LABELS) && (
                  <option value={initial.dateMode}>{initial.dateMode} (不明な値)</option>
                )}
              </select>
              {fieldError("dateMode") && <p className="text-xs text-red-600 mt-1">{fieldError("dateMode")}</p>}
            </div>
          </div>

          <div>
            <label htmlFor="dateDisplay" className={LABEL}>
              日付の表示 (date_display)
            </label>
            <input
              id="dateDisplay"
              name="dateDisplay"
              type="text"
              value={values.dateDisplay}
              onChange={(e) => set("dateDisplay", e.target.value)}
              disabled={isSaving}
              placeholder="例: 2025年7月頃"
              className={INPUT}
            />
          </div>

          <div>
            <label htmlFor="publishedAt" className={LABEL}>
              公開日 (published_at)
            </label>
            <input
              id="publishedAt"
              name="publishedAt"
              type="date"
              value={values.publishedAt}
              onChange={(e) => set("publishedAt", e.target.value)}
              disabled={isSaving}
              className={INPUT}
            />
            {fieldError("publishedAt") && (
              <p className="text-xs text-red-600 mt-1">{fieldError("publishedAt")}</p>
            )}
          </div>

          <div>
            <label htmlFor="articleUpdatedAt" className={LABEL}>
              更新日 (updated_at)
            </label>
            <div className="flex gap-2">
              <input
                id="articleUpdatedAt"
                name="articleUpdatedAt"
                type="date"
                value={values.articleUpdatedAt}
                onChange={(e) => set("articleUpdatedAt", e.target.value)}
                disabled={isSaving}
                className={INPUT}
              />
              <button
                type="button"
                disabled={isSaving}
                onClick={() => set("articleUpdatedAt", todayJst())}
                className="shrink-0 px-2 py-1 rounded border border-slate-300 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                今日にする
              </button>
            </div>
            {fieldError("articleUpdatedAt") && (
              <p className="text-xs text-red-600 mt-1">{fieldError("articleUpdatedAt")}</p>
            )}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-700">
            {/* 下書き (サイトで非表示) は詳細ページのボタンで切り替える (#327)。値は保存で消えないよう送るだけ */}
            {values.draft && <input type="hidden" name="draft" value="on" />}
            {(Object.entries(ARTICLE_FLAG_LABELS) as [keyof typeof ARTICLE_FLAG_LABELS, string][])
              .filter(([key]) => key !== "draft")
              .map(([key, label]) => (
              <label key={key} className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  name={key}
                  checked={values[key]}
                  onChange={(e) => set(key, e.target.checked)}
                  disabled={isSaving}
                />
                {label}
              </label>
              ))}
          </div>

          {extraKeys.length > 0 && (
            <p className="text-xs text-slate-400">
              モデル外の frontmatter: {extraKeys.join(", ")}（ここでは触れません。push 時に復元されます）
            </p>
          )}
        </div>

        {/* 聖地 (#283) */}
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-medium text-slate-700 mb-2">聖地 {placeIds.length} 件（訪問順。push で locations になる）</h2>
          <PlacePicker value={placeIds} onChange={setPlaceIds} options={placeOptions} disabled={isSaving} />
        </div>

        {/* 出典 (参照用) */}
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-medium text-slate-700 mb-2">出典 {sources.length} 件（本文の ^[n] と対応）</h2>
          {reservedSources.length > 0 && (
            <ul className="mb-2 space-y-1 text-xs text-slate-700">
              {reservedSources.map((r) => (
                <li key={r.sourceNo} className="flex items-baseline gap-1.5">
                  <span className="font-mono text-slate-400 shrink-0 w-7">[{r.sourceNo}]</span>
                  <span className="truncate">{r.title}</span>
                  <span className="shrink-0 text-amber-700">
                    {footnoteRefsInBody(values.body).includes(r.sourceNo)
                      ? "（保存で確定）"
                      : `（本文に ^[${r.sourceNo}] がありません）`}
                  </span>
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() => setReservedSources((prev) => prev.filter((x) => x.sourceNo !== r.sourceNo))}
                    aria-label="予約を取り消す"
                    title={`予約を取り消す (本文の ^[${r.sourceNo}] は自分で消す)`}
                    className="ml-auto shrink-0 px-1 text-slate-400 hover:text-slate-700"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          {sources.length === 0 ? (
            <p className="text-xs text-slate-400">出典なし</p>
          ) : (
            <ul className="space-y-1 text-xs text-slate-700">
              {sources.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setOpenSourceId(s.id)}
                    title="中身を横に出す"
                    className="w-full flex items-baseline gap-1.5 text-left rounded px-1 -mx-1 hover:bg-slate-50"
                  >
                    <span className="font-mono text-slate-400 shrink-0 w-7">
                      {s.sourceNo != null ? `[${s.sourceNo}]` : "—"}
                    </span>
                    <span className="truncate hover:text-blue-700">{s.label || "(ラベルなし)"}</span>
                    {s.status !== "applied" && (
                      <span className="shrink-0 text-slate-400">({ARTICLE_SOURCE_STATUS_LABELS[s.status]})</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-400 mt-2">
            押すと中身を横に出します。出典の追加・解除・反映は詳細ページから行います
          </p>
        </div>
        </div>

        {/* 保存 */}
        <div className="space-y-2">
          {needsReview && (
            <div className="text-sm rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 space-y-1.5">
              <p className="text-violet-800">
                {ARTICLE_REVIEW_LABELS.needsReview}の記事です。手直しが済んだら「{ARTICLE_REVIEW_LABELS.markReviewed}」を付けてから保存してください（push 画面で選べるようになります）
              </p>
              <label className="inline-flex items-center gap-1.5 text-violet-900">
                <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} disabled={isSaving} />
                {ARTICLE_REVIEW_LABELS.markReviewed}
              </label>
            </div>
          )}
          {state?.error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{state.error}</div>
          )}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={isSaving || !changed}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
            >
              {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {isSaving ? "保存中…" : "保存"}
            </button>
            <Link href={`/articles/${shortId}`} className="text-sm text-slate-500 hover:underline">
              キャンセル
            </Link>
          </div>
          <p className="text-xs text-slate-400">保存しても GitHub にはまだ書き出されません（/articles/push から）</p>
        </div>
      </aside>
    </form>
  );
}
