"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { renameCollectionAction, deleteCollectionAction } from "./actions";

interface CollectionItem {
  id: string;
  name: string;
  query: string;
  startDate: string | null;
  endDate: string | null;
  total: number;
  keep: number;
  reject: number;
  undecided: number;
  lastFetchedAt: string | null;
}

export function CollectionList({ items }: { items: CollectionItem[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  function handleRename(item: CollectionItem) {
    const name = window.prompt("新しい名前", item.name);
    if (name === null || !name.trim()) return;
    setBusyId(item.id);
    startTransition(async () => {
      await renameCollectionAction(item.id, name);
      setBusyId(null);
      router.refresh();
    });
  }

  function handleDelete(item: CollectionItem) {
    if (!window.confirm(`「${item.name}」を削除しますか？（ツイートと画像も削除されます）`)) return;
    setBusyId(item.id);
    startTransition(async () => {
      await deleteCollectionAction(item.id);
      setBusyId(null);
      router.refresh();
    });
  }

  if (items.length === 0) {
    return (
      <p className="text-slate-400 py-8 text-center text-sm">
        まだありません。上のフォームから作成してください。
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((c) => (
        <div
          key={c.id}
          className={`p-3 bg-white border border-slate-200 rounded-lg hover:border-slate-300 ${
            busyId === c.id ? "opacity-50" : ""
          }`}
        >
          <div className="flex items-start gap-2">
            <Link href={`/repo/${c.id}`} className="flex-1 min-w-0">
              <div className="font-medium text-slate-900 truncate">{c.name}</div>
              <div className="text-xs text-slate-400 truncate">
                {c.query} ｜ {c.startDate || "?"} 〜 {c.endDate || "?"}
              </div>
            </Link>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => handleRename(c)}
                disabled={isPending}
                className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100"
              >
                名前変更
              </button>
              <button
                onClick={() => handleDelete(c)}
                disabled={isPending}
                className="text-xs px-2 py-1 rounded text-red-600 hover:bg-red-50"
              >
                削除
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
              計 {c.total}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700">
              採用 {c.keep}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-700">
              却下 {c.reject}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
