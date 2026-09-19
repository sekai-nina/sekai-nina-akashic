"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { ImagePlus } from "lucide-react";

/**
 * その回だけの参考画像のアップロード (#159)。
 *
 * **Server Action ではなく API route に投げる** (Server Action の本文は既定 1MB までで、
 * 写真は普通にそれを超える)。アセットにもドシエにも入らない。
 */
export function RefUpload({ meetGreetId }: { meetGreetId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    if (files.length === 0) return;
    setMsg(`アップロード中… (${files.length} 枚)`);
    let failed = 0;
    for (const file of files) {
      const data = new FormData();
      data.set("file", file);
      const res = await fetch(`/api/meetgreets/${meetGreetId}/sketch-refs`, {
        method: "POST",
        body: data,
      })
        .then((r) => r.json().then((j: { error?: string }) => ({ ok: r.ok, ...j })))
        .catch(() => ({ ok: false, error: "通信に失敗しました" }));
      if (!res.ok) {
        failed += 1;
        setMsg(`エラー: ${res.error ?? "アップロードできませんでした"}`);
      }
    }
    if (failed === 0) setMsg(`${files.length} 枚を足しました`);
    if (inputRef.current) inputRef.current.value = "";
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <label className="inline-flex items-center gap-1 h-8 px-3 rounded-md border border-slate-200 text-xs text-slate-700 hover:bg-slate-50 cursor-pointer">
        <ImagePlus size={12} aria-hidden />
        参考画像を足す
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={onPick}
          disabled={pending}
          className="sr-only"
        />
      </label>
      <span className="text-[11px] text-slate-500">
        ドシエには入りません。この回のスケッチにだけ使います
      </span>
      {msg && (
        <span role="status" className="text-xs text-slate-500">
          {msg}
        </span>
      )}
    </div>
  );
}
