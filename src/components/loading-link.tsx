"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

interface LoadingLinkProps {
  href: string;
  children: React.ReactNode;
  className?: string;
}

export function LoadingLink({ href, children, className }: LoadingLinkProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    startTransition(() => {
      router.push(href, { scroll: false });
    });
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className={`${className ?? ""} disabled:opacity-70 inline-flex items-center gap-1.5`}
    >
      {isPending && <Loader2 size={12} className="animate-spin" />}
      {children}
    </button>
  );
}
