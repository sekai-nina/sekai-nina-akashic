"use client";

import { useOptimistic, useState, useTransition } from "react";
import { reviewTestimonial, updateTestimonialCategory, updateTestimonialTrait } from "@/lib/actions";

interface Testimonial {
  id: string;
  quote: string;
  trait: string;
  category: string;
  speakerName: string;
  sourceUrl: string | null;
  sourceDate: string | null;
  status: string;
  confidence: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  personality: "人柄",
  performance: "パフォーマンス",
  relationship: "関係性",
};

const CATEGORIES = Object.keys(CATEGORY_LABELS);

/**
 * Append a Text Fragment (#:~:text=) so supporting browsers (Chrome/Edge/
 * Firefox) auto-scroll to and highlight the quote on the original blog page.
 * Safari ignores the fragment and simply opens the page at the top.
 * Long quotes use the `start,end` range form for a more reliable match.
 */
function blogHrefWithScroll(url: string, quote: string): string {
  const q = quote.trim();
  if (!q) return url;
  const enc = (s: string) =>
    encodeURIComponent(s).replace(/[-~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const frag = q.length <= 40 ? enc(q) : `${enc(q.slice(0, 16))},${enc(q.slice(-16))}`;
  return `${url}#:~:text=${frag}`;
}

type OptimisticAction =
  | { type: "status"; id: string; status: string }
  | { type: "category"; id: string; category: string }
  | { type: "trait"; id: string; trait: string };

/**
 * trait(言われ方)のピル。クリックで入力欄になり、Enter / フォーカスを外すと保存。Esc で戻す。
 * サイトの「よく言われること」はこの文字列をそのまま数えるので、表記ゆれを手で直せるようにしておく。
 */
function TraitPill({ trait, onSave }: { trait: string; onSave: (trait: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(trait);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => { setDraft(trait); setEditing(true); }}
        title="クリックして言われ方を直す"
        className={`text-xs px-2 py-0.5 rounded-full ${
          trait ? "bg-blue-50 text-blue-700 hover:bg-blue-100" : "bg-slate-50 text-slate-400 hover:bg-slate-100"
        }`}
      >
        {trait || "言われ方なし"}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== trait) onSave(draft.trim());
  };

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setDraft(trait); setEditing(false); }
      }}
      placeholder="優しい, 可愛い"
      className="text-xs px-2 py-0.5 rounded-full border border-blue-300 bg-white text-blue-700 w-40 outline-none"
    />
  );
}

export function TestimonialList({ items }: { items: Testimonial[] }) {
  const [isPending, startTransition] = useTransition();
  const [optimisticItems, updateOptimistic] = useOptimistic(
    items,
    (current, action: OptimisticAction) => {
      if (action.type === "status") {
        return current.map((t) => (t.id === action.id ? { ...t, status: action.status } : t));
      }
      if (action.type === "category") {
        return current.map((t) => (t.id === action.id ? { ...t, category: action.category } : t));
      }
      if (action.type === "trait") {
        return current.map((t) => (t.id === action.id ? { ...t, trait: action.trait } : t));
      }
      return current;
    }
  );

  function handleStatus(id: string, status: "approved" | "rejected") {
    updateOptimistic({ type: "status", id, status });
    startTransition(async () => {
      await reviewTestimonial(id, status);
    });
  }

  function handleCategory(id: string, category: string) {
    updateOptimistic({ type: "category", id, category });
    startTransition(async () => {
      await updateTestimonialCategory(id, category);
    });
  }

  function handleTrait(id: string, trait: string) {
    updateOptimistic({ type: "trait", id, trait });
    startTransition(async () => {
      await updateTestimonialTrait(id, trait);
    });
  }

  if (optimisticItems.length === 0) {
    return <p className="text-slate-400 py-8 text-center">該当なし</p>;
  }

  return (
    <div className="space-y-3">
      {optimisticItems.map((t) => (
        <div
          key={t.id}
          className={`border rounded-lg p-4 bg-white transition-opacity ${
            t.status === "pending" ? "border-slate-200" : "border-slate-100 opacity-60"
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-slate-900 text-sm leading-relaxed whitespace-pre-wrap">
                「{t.quote}」
              </p>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <select
                  value={t.category}
                  onChange={(e) => handleCategory(t.id, e.target.value)}
                  className="text-xs px-2 py-0.5 bg-slate-100 rounded-full text-slate-600 border-none cursor-pointer hover:bg-slate-200"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {CATEGORY_LABELS[cat]}
                    </option>
                  ))}
                </select>
                <TraitPill trait={t.trait} onSave={(trait) => handleTrait(t.id, trait)} />
                <span className="text-xs text-slate-400">
                  — {t.speakerName}
                </span>
                {t.sourceDate && (
                  <span className="text-xs text-slate-400">
                    {t.sourceDate.slice(0, 10)}
                  </span>
                )}
                <span className="text-xs text-slate-300">
                  conf: {(t.confidence * 100).toFixed(0)}%
                </span>
                {t.sourceUrl && (
                  <a
                    href={blogHrefWithScroll(t.sourceUrl, t.quote)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-500 hover:underline ml-auto"
                  >
                    元ブログ →
                  </a>
                )}
              </div>
            </div>

            <div className="flex gap-1 shrink-0 items-center">
              {t.status !== "approved" && (
                <button
                  onClick={() => handleStatus(t.id, "approved")}
                  className="px-3 py-1 text-xs bg-green-50 text-green-700 rounded hover:bg-green-100"
                >
                  承認
                </button>
              )}
              {t.status !== "rejected" && (
                <button
                  onClick={() => handleStatus(t.id, "rejected")}
                  className="px-3 py-1 text-xs bg-red-50 text-red-700 rounded hover:bg-red-100"
                >
                  却下
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
