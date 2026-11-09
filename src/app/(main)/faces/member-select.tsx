"use client";

import { useRouter } from "next/navigation";

/** 推定したメンバーで絞るメニュー。選んだら 1 ページ目に移る */
export function MemberSelect({
  mode,
  value,
  options,
}: {
  mode: string;
  value: string;
  options: { id: string; label: string }[];
}) {
  const router = useRouter();
  return (
    <select
      value={value}
      onChange={(e) => router.push(`/faces?${new URLSearchParams({ mode, entity: e.target.value })}`)}
      className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700"
      aria-label="推定したメンバー"
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
