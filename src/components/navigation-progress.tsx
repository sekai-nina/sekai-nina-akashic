"use client";

import { useEffect, useState, useTransition, useCallback } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  // pathname or searchParams の変更で完了とみなす
  useEffect(() => {
    setLoading(false);
    setProgress(0);
  }, [pathname, searchParams]);

  // グローバルにクリックイベントを監視して、Link遷移を検出
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = (e.target as HTMLElement).closest("a");
      if (!target) return;

      const href = target.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("http") || href.startsWith("mailto:")) return;
      if (target.getAttribute("target") === "_blank") return;
      if (target.hasAttribute("download")) return;

      // 現在と同じURLなら無視
      const current = window.location.pathname + window.location.search;
      if (href === current) return;

      // 同一パスでクエリパラメータだけ変わる場合はプログレスバーを出さない
      // （ページ内のフィルタ切替や言及検索など、遷移ではなくページ内操作に見える）
      const url = new URL(href, window.location.origin);
      if (url.pathname === window.location.pathname) return;

      setLoading(true);
      setProgress(20);
    }

    // form submit も検出（Server Action）
    function handleSubmit(e: Event) {
      const form = e.target as HTMLFormElement;
      if (form.tagName !== "FORM") return;

      // action属性が別パスへの遷移の場合のみプログレスバーを表示
      const action = form.getAttribute("action");
      if (action && action !== window.location.pathname) {
        setLoading(true);
        setProgress(20);
      }
      // 同一パスへのGETフォーム（検索等）や、preventDefault済みの
      // クライアントサイドsubmitではプログレスバーを出さない
    }

    document.addEventListener("click", handleClick, true);
    document.addEventListener("submit", handleSubmit, true);
    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("submit", handleSubmit, true);
    };
  }, []);

  // ローディング中のプログレスアニメーション + タイムアウト
  useEffect(() => {
    if (!loading) return;

    const timer = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 90) return prev;
        return prev + (90 - prev) * 0.1;
      });
    }, 200);

    // 10秒経っても完了しない場合は強制終了
    const timeout = setTimeout(() => {
      setLoading(false);
      setProgress(0);
    }, 10000);

    return () => {
      clearInterval(timer);
      clearTimeout(timeout);
    };
  }, [loading]);

  if (!loading) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] h-0.5">
      <div
        className="h-full bg-blue-500 transition-all duration-200 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}
