import { hasFootnoteIssues, type FootnoteAudit } from "@/lib/articles/footnotes";

/**
 * 本文と出典・記事間リンクの対応の壊れを出す警告ブロック。
 * 詳細ページと編集ページのプレビューで同じものを出す (片方だけ直すと食い違うので共有する)。
 * 指摘が無ければ何も描かない。Server / Client どちらからも使える (状態を持たない)。
 */
export function FootnoteAuditWarnings({ audit, className }: { audit: FootnoteAudit; className?: string }) {
  if (!hasFootnoteIssues(audit)) return null;
  const { missingSources, unreferenced, numericWikiLinks, brokenLinks } = audit;
  return (
    <div
      className={`text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 space-y-0.5 ${className ?? ""}`}
    >
      {missingSources.length > 0 && (
        <p>本文が指している出典がありません: {missingSources.map((n) => `^[${n}]`).join(" ")}</p>
      )}
      {unreferenced.length > 0 && (
        <p>本文から参照されていない出典があります: {unreferenced.map((n) => `[${n}]`).join(" ")}</p>
      )}
      {numericWikiLinks.length > 0 && (
        <p>
          脚注が {numericWikiLinks.map((n) => `[[${n}]]`).join(" ")} と書かれています（
          {numericWikiLinks.map((n) => `^[${n}]`).join(" ")} の誤りと思われます）
        </p>
      )}
      {brokenLinks.length > 0 && <p>宛先の無い記事リンク: {brokenLinks.map((t) => `[[${t}]]`).join(" ")}</p>}
    </div>
  );
}
