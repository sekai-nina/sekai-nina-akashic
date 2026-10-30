import { notFound } from "next/navigation";
import { Suspense } from "react";
import { search, splitQueryTerms, type SearchResult } from "@/lib/search";
import { auth } from "@/lib/auth";
import { getCachedEntityList } from "@/lib/cache";
import { listDossierMembershipForAssets, listEditableDossiers, type AssetDossierMembership } from "@/lib/domain/dossiers";
import { isNinaAppearance } from "@/lib/nina";
import { AddToDossier } from "@/components/add-to-dossier";
import { ASSET_KIND_LABELS, formatDate } from "@/lib/utils";
import { SearchForm } from "./search-form";
import { SEARCH_PARAM_KEYS } from "./params";
import Link from "next/link";
import type { AssetKind, ClearanceLevel, SourceType } from "@prisma/client";

interface EditableDossier { id: string; title: string }
interface SessionUser { id: string; role: string; clearance: string }

/** ページ送りで戻る先。ページの頭ではなく結果の頭に飛ばす (検索フォームが長いので) */
const RESULTS_ANCHOR = "search-results";

/** Kinds that are best browsed as a grid — selecting only these defaults to gallery view. */
const VISUAL_KINDS: AssetKind[] = ["image", "video"];

const PER_PAGE = 20;

function parseKinds(raw: string | undefined): AssetKind[] {
  if (!raw) return [];
  const valid = new Set(Object.keys(ASSET_KIND_LABELS));
  return raw.split(",").filter((k) => valid.has(k)) as AssetKind[];
}

/** Gallery is the natural default when every selected kind is visual. */
function defaultView(kinds: AssetKind[]): "list" | "gallery" {
  return kinds.length > 0 && kinds.every((k) => VISUAL_KINDS.includes(k)) ? "gallery" : "list";
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
      {ASSET_KIND_LABELS[kind] ?? kind}
    </span>
  );
}

function stripPlaceholders(text: string): string {
  return text.replace(/\{\{IMG:[a-zA-Z0-9_-]+\}\}/g, "").replace(/[ \t]{2,}/g, " ");
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  const cleaned = stripPlaceholders(text);
  if (!query.trim()) return <>{cleaned}</>;
  const terms = splitQueryTerms(query);
  if (terms.length === 0) return <>{cleaned}</>;
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const regex = new RegExp(`(${pattern})`, "gi");
  const parts = cleaned.split(regex);
  const termsLower = new Set(terms.map((t) => t.toLowerCase()));
  return (
    <>
      {parts.map((part, i) =>
        termsLower.has(part.toLowerCase()) ? (
          <mark key={i} className="bg-yellow-200 text-yellow-900 rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

const MATCH_FIELD_LABELS: Record<string, string> = {
  title: "タイトル", description: "説明", messageBodyPreview: "メッセージ",
  entity: "エンティティ", note: "メモ", body: "本文", sourceUrl: "URL",
  ocr: "OCR", transcript: "文字起こし", extracted: "抽出テキスト",
};

/** 企画・クリップに入っている数。ギャラリーでは画像に重ねる (overlay) */
function MembershipBadges({ membership, overlay }: { membership?: AssetDossierMembership; overlay?: boolean }) {
  if (!membership) return null;
  const { dossiers, clipCount } = membership;
  if (dossiers.length === 0 && clipCount === 0) return null;
  const base = overlay
    ? "inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium shadow-sm"
    : "inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium";
  return (
    <>
      {dossiers.length > 0 && (
        <span className={`${base} ${overlay ? "bg-emerald-600/90 text-white" : "bg-emerald-50 text-emerald-700"}`}
          title={`入っている企画: ${dossiers.map((d) => d.title).join("、")}`}>
          企画 {dossiers.length}
        </span>
      )}
      {clipCount > 0 && (
        <span className={`${base} ${overlay ? "bg-amber-500/90 text-white" : "bg-amber-50 text-amber-700"}`}
          title={`クリップ ${clipCount} 件`}>
          クリップ {clipCount}
        </span>
      )}
    </>
  );
}

function Pagination({ page, hasNextPage, buildUrl, className }: {
  page: number;
  hasNextPage: boolean;
  buildUrl: (overrides: Record<string, string | undefined>) => string;
  className?: string;
}) {
  if (page <= 1 && !hasNextPage) return null;
  const linkClass = "border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50";
  const disabledClass = "border border-slate-200 text-slate-300 px-3 py-1.5 rounded text-sm cursor-default";
  // 押すたびにボタンの位置がずれないよう、押せない側も枠だけ残す
  return (
    <div className={`flex items-center justify-between ${className ?? ""}`}>
      <span className="text-sm text-slate-500">{page} ページ目</span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={`${buildUrl({ page: String(page - 1) })}#${RESULTS_ANCHOR}`} className={linkClass}>← 前へ</Link>
        ) : (
          <span className={disabledClass} aria-disabled="true">← 前へ</span>
        )}
        {hasNextPage ? (
          <Link href={`${buildUrl({ page: String(page + 1) })}#${RESULTS_ANCHOR}`} className={linkClass}>次へ →</Link>
        ) : (
          <span className={disabledClass} aria-disabled="true">次へ →</span>
        )}
      </div>
    </div>
  );
}

function SearchResultsSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-4 w-16 bg-slate-200 rounded" />
        <div className="flex gap-1">
          <div className="h-7 w-14 bg-slate-200 rounded" />
          <div className="h-7 w-20 bg-slate-200 rounded" />
        </div>
      </div>
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3">
            <div className="w-14 h-14 bg-slate-100 rounded shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-3/4 bg-slate-100 rounded" />
              <div className="h-3 w-full bg-slate-50 rounded" />
              <div className="h-3 w-1/2 bg-slate-50 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

async function SearchResults({
  params,
  user,
  editableDossiers,
}: {
  params: { [key: string]: string | undefined };
  user: SessionUser;
  editableDossiers: EditableDossier[];
}) {
  const clearance = user.clearance as ClearanceLevel;
  const q = params.q ?? "";
  const page = Math.max(1, parseInt(params.page ?? "1"));

  const effectiveTarget = (params.target as "all" | "assets" | "texts") || "all";
  const effectiveSourceType = params.sourceType as SourceType | undefined;
  const effectiveKinds = parseKinds(params.kind);
  const effectiveView = params.view ? (params.view as "list" | "gallery") : defaultView(effectiveKinds);

  const effectiveEntityIds: string[] = params.entityIds
    ? params.entityIds.split(",").filter(Boolean)
    : [];
  // 既定は OR（いずれかを含む）。すべてを含む絞り込みは entityMatch=all で明示する。
  const effectiveEntityMatch = params.entityMatch === "all" ? "all" : "any";

  const selectedAuthorIds: string[] = params.authorIds
    ? params.authorIds.split(",").filter(Boolean)
    : [];

  const ninaAppearance = isNinaAppearance(params.nina) ? params.nina : undefined;

  const hasFilters = !!(effectiveKinds.length > 0 || effectiveSourceType || params.dateFrom || params.dateTo || effectiveEntityIds.length > 0 || selectedAuthorIds.length > 0 || ninaAppearance);

  // ギャラリーは画像・動画だけを並べる。件数とページ送りが合うよう、表示側ではなく検索条件で絞る
  const isGallery = effectiveView === "gallery";

  // 条件が空でも、ギャラリーなら画像・動画の新しい順の一覧として意味があるので検索する
  if (!q.trim() && !hasFilters && !isGallery) {
    return (
      <div className="text-center py-16 text-slate-400">
        <p>キーワードを入力するか、種別を選択して検索してください</p>
        <Link scroll={false} href={buildUrl({ view: "gallery", page: "1" })}
          className="inline-block mt-3 text-sm text-blue-500 hover:underline">
          画像・動画を一覧する
        </Link>
      </div>
    );
  }

  const searchKinds = isGallery
    ? (effectiveKinds.length > 0 ? effectiveKinds.filter((k) => VISUAL_KINDS.includes(k)) : VISUAL_KINDS)
    : effectiveKinds;
  const noVisualKinds = isGallery && searchKinds.length === 0;

  const results: SearchResult = noVisualKinds
    ? { items: [], total: 0, page, perPage: PER_PAGE }
    : await search({
        q, target: effectiveTarget, sourceType: effectiveSourceType,
        kinds: searchKinds.length > 0 ? searchKinds : undefined,
        entityIds: effectiveEntityIds.length > 0 ? effectiveEntityIds : undefined,
        entityMatch: effectiveEntityMatch,
        authorIds: selectedAuthorIds.length > 0 ? selectedAuthorIds : undefined,
        dateFrom: params.dateFrom ? new Date(params.dateFrom) : undefined,
        dateTo: params.dateTo ? new Date(params.dateTo) : undefined,
        ninaAppearance,
        page, perPage: PER_PAGE,
      }, clearance);

  // 企画・クリップのバッジ。失敗しても結果は出す
  const memberships = await listDossierMembershipForAssets(user, [...new Set(results.items.map((i) => i.assetId))])
    .catch((e: unknown) => {
      console.error("企画・クリップの件数の取得に失敗:", e);
      return new Map<string, AssetDossierMembership>();
    });

  // 件数が正確になったので、最終ページで「次へ」が空振りしないよう total で判定する
  const hasNextPage = page * results.perPage < results.total;

  // 表示切替やページ送りで絞り込みが落ちないよう、既知のパラメータはすべて引き継ぐ
  function buildUrl(overrides: Record<string, string | undefined>) {
    const p = new URLSearchParams();
    const merged = { ...params, ...overrides };
    for (const key of SEARCH_PARAM_KEYS) {
      const value = merged[key];
      if (!value) continue;
      if (key === "page" && value === "1") continue;
      p.set(key, value);
    }
    return `/search?${p.toString()}`;
  }

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-slate-500">
          {results.total} 件
          {q && (() => {
            const totalMatches = results.items.reduce((sum, item) => sum + item.matchCount, 0);
            return totalMatches > results.total ? ` (${totalMatches} 箇所)` : "";
          })()}
          {isGallery && <span className="ml-2 text-xs text-slate-400">ギャラリーには画像と動画だけを表示します</span>}
        </span>
        <div className="flex gap-1">
          <Link scroll={false} href={buildUrl({ view: "list", page: "1" })}
            className={`px-3 py-1 rounded text-sm border transition-colors ${effectiveView === "list" ? "bg-slate-700 text-white border-slate-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
            リスト
          </Link>
          <Link scroll={false} href={buildUrl({ view: "gallery", page: "1" })}
            className={`px-3 py-1 rounded text-sm border transition-colors ${effectiveView === "gallery" ? "bg-slate-700 text-white border-slate-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
            ギャラリー
          </Link>
        </div>
      </div>

      <Pagination page={page} hasNextPage={hasNextPage} buildUrl={buildUrl} className="mb-3" />

      {results.items.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          {noVisualKinds ? (
            <p>
              選んだ種別に画像・動画が無いため、ギャラリーには何も出ません。
              <Link scroll={false} href={buildUrl({ view: "list", page: "1" })} className="text-blue-500 hover:underline">リスト表示</Link>
              に切り替えてください
            </p>
          ) : (
            <p>{q ? `「${q}」に一致するアセットが見つかりませんでした` : "条件に一致するアセットが見つかりませんでした"}</p>
          )}
        </div>
      ) : effectiveView === "gallery" ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {results.items.map((item, idx) => (
            <div key={`${item.assetId}-${idx}`} className="relative group">
              <Link href={`/assets/${item.assetId}`}
                className="block bg-white border border-slate-200 rounded-lg overflow-hidden hover:border-blue-400 transition-colors">
                {/* storageUrl は Drive の閲覧ページ (HTML) の URL なので <img> には使えない。
                    サムネイルが無ければ kind ラベルのプレースホルダを出す */}
                <div className="relative">
                  {item.thumbnailUrl ? (
                    <img src={item.thumbnailUrl} alt={item.assetTitle} className="w-full h-32 object-cover" />
                  ) : (
                    <div className="w-full h-32 bg-slate-100 flex items-center justify-center text-slate-400 text-xs">
                      {ASSET_KIND_LABELS[item.assetKind] ?? item.assetKind}
                    </div>
                  )}
                  {/* 右上は「企画に追加」のボタンが出るので左下に置く */}
                  <div className="absolute bottom-1.5 left-1.5 flex gap-1">
                    <MembershipBadges membership={memberships.get(item.assetId)} overlay />
                  </div>
                </div>
                <div className="p-2">
                  <p className="text-xs font-medium text-slate-800 line-clamp-2">{item.assetTitle}</p>
                  <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                    <KindBadge kind={item.assetKind} />
                    <span className="text-[11px] text-slate-400">
                      {formatDate(item.canonicalDate ?? item.createdAt)}
                    </span>
                  </div>
                </div>
              </Link>
              {editableDossiers.length > 0 && (
                // ホバーで出すのはマウスのある端末だけ。スマホはホバーが無いので常に出す
                <div className="absolute top-1.5 right-1.5 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
                  <AddToDossier
                    assetId={item.assetId}
                    dossiers={editableDossiers}
                    defaultCaption={item.assetTitle}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {results.items.map((item, idx) => (
            <div key={`${item.assetId}-${idx}`} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50 transition-colors">
              <Link href={`/assets/${item.assetId}`} className="flex items-start gap-3 flex-1 min-w-0">
                {/* storageUrl は Drive の閲覧ページ (HTML) の URL なので <img> には使えない。
                    サムネイルが無ければ kind ラベルのプレースホルダを出す（ギャラリー表示と同じ扱い） */}
                {item.thumbnailUrl ? (
                  <img src={item.thumbnailUrl} alt="" className="w-14 h-14 object-cover rounded shrink-0 bg-slate-100" />
                ) : (
                  <div className="w-14 h-14 rounded shrink-0 bg-slate-100 flex items-center justify-center text-slate-400 text-[10px] text-center leading-tight px-1">
                    {ASSET_KIND_LABELS[item.assetKind] ?? item.assetKind}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-slate-900">{item.assetTitle}</span>
                    <KindBadge kind={item.assetKind} />
                    <span className="text-xs text-slate-400">{MATCH_FIELD_LABELS[item.matchField] ?? item.matchField}</span>
                    {item.matchCount > 1 && (
                      <span className="text-xs text-blue-500 font-medium">×{item.matchCount}</span>
                    )}
                    <MembershipBadges membership={memberships.get(item.assetId)} />
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {item.snippets.map((snip, si) => (
                      <p key={si} className="text-xs text-slate-500">
                        <HighlightedSnippet text={snip} query={q} />
                      </p>
                    ))}
                    {item.bodyPreview && (
                      <p className="text-xs text-slate-500 line-clamp-3 whitespace-pre-wrap">
                        <HighlightedSnippet text={item.bodyPreview} query={q} />
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-xs text-slate-400 flex-wrap">
                    <span>{formatDate(item.canonicalDate ?? item.createdAt)}</span>
                    {item.personNames.length > 0 && (
                      <span>{item.personNames.join(", ")}</span>
                    )}
                    {item.tagNames.length > 0 && item.tagNames.map((tag) => (
                      <span key={tag} className="bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{tag}</span>
                    ))}
                  </div>
                </div>
              </Link>
              <div className="flex items-center gap-2 shrink-0">
                {item.storageUrl && (
                  <a href={item.storageUrl} target="_blank" rel="noopener noreferrer"
                    className="text-slate-400 hover:text-blue-500 transition-colors p-1" title="Google Drive で開く">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M7.71 3.5L1.15 15l4.58 7.5h13.54l4.58-7.5L17.29 3.5H7.71zm.58 1h8.42l5.83 10.5h-5.07l-4.5-7.78-4.5 7.78H3.4L8.29 4.5zm3.68 3.72L8.2 15h7.56l-3.79-6.78zM2.27 16h4.86l2.29 3.75H4.56L2.27 16zm12.31 0h4.86l-2.29 3.75h-4.86l2.29-3.75z"/></svg>
                  </a>
                )}
                {editableDossiers.length > 0 && (
                  <AddToDossier
                    assetId={item.assetId}
                    dossiers={editableDossiers}
                    defaultCaption={item.assetTitle}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Pagination page={page} hasNextPage={hasNextPage} buildUrl={buildUrl} className="mt-4" />
    </>
  );
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  const session = await auth();
  // middleware がログインへ飛ばすが、レンダリングはそれと競合して走る。
  // ガードしないと未認証リクエストのたびにサーバー側で例外になる
  if (!session?.user) notFound();
  const userClearance = session.user.clearance as ClearanceLevel;
  const [entities, editableDossiers] = await Promise.all([
    getCachedEntityList(userClearance),
    listEditableDossiers(session.user).then((ds) => ds.map((d) => ({ id: d.id, title: d.title }))),
  ]);

  const params = await searchParams;
  const q = params.q ?? "";
  const selectedKinds = parseKinds(params.kind);

  const selectedEntityIds: string[] = params.entityIds
    ? params.entityIds.split(",").filter(Boolean)
    : [];
  const selectedAuthorIds: string[] = params.authorIds
    ? params.authorIds.split(",").filter(Boolean)
    : [];

  const hasQuery = !!(q.trim() || selectedKinds.length > 0 || params.dateFrom || params.dateTo || selectedEntityIds.length > 0 || selectedAuthorIds.length > 0 || isNinaAppearance(params.nina));

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">検索</h1>
      </div>

      <Suspense>
        <SearchForm
          initialQ={q}
          initialKinds={selectedKinds}
          initialEntityIds={selectedEntityIds}
          initialEntityMatch={params.entityMatch === "all" ? "all" : "any"}
          initialAuthorIds={selectedAuthorIds}
          entities={entities}
        />
      </Suspense>

      {hasQuery ? (
        <div id={RESULTS_ANCHOR} className="scroll-mt-4">
          <Suspense fallback={<SearchResultsSkeleton />}>
            <SearchResults params={params} user={session.user} editableDossiers={editableDossiers} />
          </Suspense>
        </div>
      ) : (
        <div className="text-center py-16 text-slate-400">
          <p>キーワードを入力するか、種別を選択して検索してください</p>
        </div>
      )}
    </div>
  );
}
