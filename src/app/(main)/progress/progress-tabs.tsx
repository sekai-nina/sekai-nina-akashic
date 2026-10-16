"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SHOWS } from "@/lib/progress/shows";
import { MATERIAL_SOURCE_KEYS } from "@/lib/clip-progress/material-items";
import { MATERIAL_PROGRESS_LABELS as L, MATERIAL_SOURCE_LABELS, cn } from "@/lib/utils";

const ARTICLE_TABS = [
  { href: "/progress/blog", label: "ブログ → 言葉記事" },
  ...Object.values(SHOWS).map((s) => ({ href: `/progress/${s.key}`, label: s.label })),
];

export function ProgressTabs() {
  const pathname = usePathname();
  return (
    <div>
      <p className="mt-4 text-xs font-semibold text-slate-500">{L.clipProgress}</p>
      <nav className="mt-1 flex flex-wrap gap-1 border-b border-slate-200" aria-label={L.clipProgress}>
        {MATERIAL_SOURCE_KEYS.map((key) => (
          <Link key={key} href={`/progress/materials/${key}`}
            className={cn("border-b-2 px-3 py-2 text-sm -mb-px", pathname === `/progress/materials/${key}`
              ? "border-slate-900 font-medium text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800")}>
            {MATERIAL_SOURCE_LABELS[key]}
          </Link>
        ))}
      </nav>
      <p className="mt-4 text-xs font-semibold text-slate-500">{L.articleProgress}</p>
      <nav className="mt-1 mb-4 flex flex-wrap gap-1 border-b border-slate-200" aria-label={L.articleProgress}>
        {ARTICLE_TABS.map((tab) => (
          <Link key={tab.href} href={tab.href}
            className={cn("px-3 py-2 text-sm -mb-px border-b-2", pathname.startsWith(tab.href)
              ? "border-slate-900 text-slate-900 font-medium" : "border-transparent text-slate-500 hover:text-slate-800")}>
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
