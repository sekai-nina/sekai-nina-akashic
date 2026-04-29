"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

interface LoadingLinkProps {
  href: string;
  children: React.ReactNode;
  className?: string;
}

export function LoadingLink({ href, children, className }: LoadingLinkProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    setLoading(true);
    router.push(href, { scroll: false });
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={`${className ?? ""} disabled:opacity-70 inline-flex items-center gap-1.5`}
    >
      {loading && <Loader2 size={12} className="animate-spin" />}
      {children}
    </button>
  );
}
