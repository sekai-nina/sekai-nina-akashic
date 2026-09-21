"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { ImagePlus } from "lucide-react";
import { ownerApiPath, WORKFLOW_OWNER_THIS, type WorkflowOwner } from "./owner";

/**
 * その器 (ミーグリ / ライブ) だけの参考画像のアップロード (#159)。
 *
 * **Server Action ではなく API route に投げる** (Server Action の本文は既定 1MB までで、
 * 写真は普通にそれを超える)。アセットにもドシエにも入らない。
 */
export function RefUpload({ owner }: { owner: WorkflowOwner }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  // **上げている間は入力を閉じる。** `pending` は後ろの refresh しか見ていないので、
  // これが無いと 2 枚目を選べてしまい、一覧の読み書きが競合する
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    if (files.length === 0) return;
    setUploading(true);
    setMsg(`アップロード中… (${files.length} 枚)`);
    let failed = 0;
    for (const file of files) {
      const data = new FormData();
      data.set("file", file);
      const res = await fetch(`${ownerApiPath(owner)}/sketch-refs`, {
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
    setUploading(false);
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <label
        className={
          "inline-flex items-center gap-1 h-8 px-3 rounded-md border border-slate-200 text-xs text-slate-700 " +
          (uploading || pending ? "opacity-50" : "hover:bg-slate-50 cursor-pointer")
        }
      >
        <ImagePlus size={12} aria-hidden />
        参考画像を足す
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={onPick}
          disabled={uploading || pending}
          className="sr-only"
        />
      </label>
      <span className="text-[11px] text-slate-500">
        ドシエには入りません。{WORKFLOW_OWNER_THIS[owner.kind]}のスケッチにだけ使います
      </span>
      {msg && (
        <span role="status" className="text-xs text-slate-500">
          {msg}
        </span>
      )}
    </div>
  );
}
