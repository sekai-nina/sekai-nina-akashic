"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setTemplateAction } from "./actions";

/**
 * 記事テンプレートを選ぶ (#170)。一度決めると記事の型 (path のディレクトリ) が決まるので、
 * 記事を作った後は変えられない (domain 側で止める)。
 */
export function TemplatePicker({
  dossierId,
  current,
  suggested,
  options,
  locked,
}: {
  dossierId: string;
  current: string | null;
  /** 紐づく記事の型から推した既定値 */
  suggested: string | null;
  options: { key: string; label: string }[];
  /** 記事を作った後は変えられない */
  locked: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(current ?? suggested ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    if (!value) return;
    setMsg("保存中…");
    startTransition(async () => {
      const res = await setTemplateAction(dossierId, value).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="text-xs text-slate-600">
        テンプレート
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={pending || locked}
          className="ml-2 h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800 disabled:opacity-60"
        >
          <option value="">選んでください</option>
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {!locked && value && value !== current && (
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="h-8 px-3 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
        >
          {current ? "変更する" : "決める"}
        </button>
      )}
      {locked && (
        <span className="text-[11px] text-slate-500">記事を作った後はテンプレートを変えられません</span>
      )}
      {!current && suggested && value === suggested && (
        <span className="text-[11px] text-slate-500">紐づいている記事の型から推しています</span>
      )}
      {msg && (
        <span role="status" className="text-xs text-slate-500">
          {msg}
        </span>
      )}
    </div>
  );
}
