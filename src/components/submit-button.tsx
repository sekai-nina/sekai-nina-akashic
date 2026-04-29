"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";

interface SubmitButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "disabled"> {
  children: React.ReactNode;
  className?: string;
  pendingText?: string;
}

export function SubmitButton({ children, className, pendingText, ...rest }: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className={`${className ?? ""} disabled:opacity-50 inline-flex items-center gap-1.5`}
      {...rest}
    >
      {pending ? (
        <>
          <Loader2 size={14} className="animate-spin" />
          {pendingText ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}
