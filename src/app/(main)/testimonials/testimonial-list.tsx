"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
  personality: "性格",
  dance: "ダンス",
  appearance: "見た目",
  habit: "癖",
  preference: "好み",
  skill: "特技",
  relationship: "関係性",
  other: "その他",
};

export function TestimonialList({ items }: { items: Testimonial[] }) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);

  async function handleAction(id: string, status: "approved" | "rejected") {
    setLoading(id);
    try {
      await fetch("/api/v1/testimonials", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      router.refresh();
    } finally {
      setLoading(null);
    }
  }

  if (items.length === 0) {
    return <p className="text-slate-400 py-8 text-center">該当なし</p>;
  }

  return (
    <div className="space-y-3">
      {items.map((t) => (
        <div
          key={t.id}
          className="border border-slate-200 rounded-lg p-4 bg-white"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-slate-900 text-sm leading-relaxed">
                「{t.quote}」
              </p>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <span className="text-xs px-2 py-0.5 bg-slate-100 rounded-full text-slate-600">
                  {CATEGORY_LABELS[t.category] || t.category}
                </span>
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

            {t.status === "pending" && (
              <div className="flex gap-1 shrink-0">
                <button
                  onClick={() => handleAction(t.id, "approved")}
                  disabled={loading === t.id}
                  className="px-3 py-1 text-xs bg-green-50 text-green-700 rounded hover:bg-green-100 disabled:opacity-50"
                >
                  承認
                </button>
                <button
                  onClick={() => handleAction(t.id, "rejected")}
                  disabled={loading === t.id}
                  className="px-3 py-1 text-xs bg-red-50 text-red-700 rounded hover:bg-red-100 disabled:opacity-50"
                >
                  却下
                </button>
              </div>
            )}

            {t.status === "approved" && (
              <span className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded-full">
                承認済
              </span>
            )}
            {t.status === "rejected" && (
              <span className="text-xs px-2 py-0.5 bg-red-100 text-red-700 rounded-full">
                却下
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
