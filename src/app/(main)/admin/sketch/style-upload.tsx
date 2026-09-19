"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * 画風の見本のアップロード (#136)。
 * **Server Action ではなく API route に投げる** (Server Action の本文は既定 1MB までで、
 * スケッチの画像は普通にそれを超える)。
 */
export function StyleReferenceUpload() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setMsg("アップロード中…");
    const res = await fetch("/api/admin/sketch-style-reference", { method: "POST", body: data })
      .then((r) => r.json().then((j: { error?: string }) => ({ ok: r.ok, ...j })))
      .catch(() => ({ ok: false, error: "通信に失敗しました" }));
    if (!res.ok) {
      setMsg(`エラー: ${res.error ?? "アップロードできませんでした"}`);
      return;
    }
    setMsg("差し替えました");
    form.reset();
    startTransition(() => router.refresh());
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 flex items-center gap-3 flex-wrap">
      <label className="text-xs text-slate-600" htmlFor="style-file">
        画像をアップロードして差し替える
      </label>
      <input
        id="style-file"
        type="file"
        name="file"
        accept="image/*"
        required
        className="text-xs text-slate-600 file:mr-2 file:h-8 file:rounded-md file:border file:border-slate-200 file:bg-white file:px-3 file:text-xs file:text-slate-700"
      />
      <button
        type="submit"
        disabled={pending}
        className="h-8 px-3 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
      >
        差し替える
      </button>
      {msg && (
        <span role="status" className="text-xs text-slate-500">
          {msg}
        </span>
      )}
    </form>
  );
}
