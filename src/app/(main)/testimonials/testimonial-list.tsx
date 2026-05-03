"use client";

import { useOptimistic, useTransition } from "react";
import { reviewTestimonial, updateTestimonialCategory } from "@/lib/actions";

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

type OptimisticAction =
  | { type: "status"; id: string; status: string }
  | { type: "category"; id: string; category: string };

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
                {t.trait && (
                  <span className="text-xs px-2 py-0.5 bg-blue-50 rounded-full text-blue-700">
                    {t.trait}
                  </span>
                )}
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
                    href={t.sourceUrl}
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
