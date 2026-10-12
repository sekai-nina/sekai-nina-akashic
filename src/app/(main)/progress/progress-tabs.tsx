"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SHOWS } from "@/lib/progress/shows";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/progress/blog", label: "ブログ → 言葉記事" },
  ...Object.values(SHOWS).map((s) => ({ href: `/progress/${s.key}`, label: s.label })),
];

export function ProgressTabs() {
  const pathname = usePathname();
  return (
    <nav className="mt-3 mb-4 flex gap-1 border-b border-slate-200">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={cn(
            "px-3 py-2 text-sm -mb-px border-b-2",
            pathname.startsWith(t.href)
              ? "border-slate-900 text-slate-900 font-medium"
              : "border-transparent text-slate-500 hover:text-slate-800"
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
