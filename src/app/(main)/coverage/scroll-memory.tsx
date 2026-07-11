"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * カバレッジ・アイテム一覧のスクロール位置記憶（(main) レイアウトに常駐）。
 *
 * このアプリのスクロールは window ではなく、レイアウトの `<main class="overflow-auto">`
 * の**内部スクロール**である。`<main>` はレイアウトごとナビゲーションを跨いで生存するため、
 * アセットページ（?hl=nina の言及への自動スクロール）で下がった scrollTop が、
 * ブラウザバック後のアイテム一覧にそのまま持ち越される（App Router の復元は window のみ）。
 *
 * 対処:
 * - /coverage/<source> 滞在中: `<main>` の scrollTop を throttle しつつ sessionStorage に記録
 * - popstate（戻る/進む）由来で /coverage/<source> に来たとき: 記録位置へ復元
 *   （リスト描画の高さが出るまで最大 ~20 フレーム リトライ）
 * - 通常遷移（マトリクスから等）では復元しない
 */
export function CoverageScrollMemory() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const url = `${pathname}?${searchParams.toString()}`;
  const isItemList = /^\/coverage\/[^/]+/.test(pathname);
  const popRef = useRef(false);

  // 戻る/進む の検出フラグ
  useEffect(() => {
    const onPop = () => {
      popRef.current = true;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // 滞在中の常時記録（throttle 150ms）。スクロール容器 = レイアウトの <main>
  useEffect(() => {
    if (!isItemList) return;
    const el = document.querySelector("main");
    if (!el) return;
    const key = `cov-scroll:${url}`;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      try {
        sessionStorage.setItem(key, String(el.scrollTop));
      } catch {
        /* noop */
      }
    };
    const onScroll = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        save();
      }, 150);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [url, isItemList]);

  // popstate 由来でアイテム一覧に来たら復元
  useEffect(() => {
    const wasPop = popRef.current;
    popRef.current = false;
    if (!wasPop || !isItemList) return;
    const el = document.querySelector("main");
    if (!el) return;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(`cov-scroll:${url}`);
    } catch {
      /* noop */
    }
    if (raw == null) return;
    const y = parseInt(raw, 10);
    if (Number.isNaN(y) || y < 0) return;
    let tries = 0;
    const attempt = () => {
      el.scrollTop = y;
      tries++;
      // コンテンツの高さがまだ足りない/他の処理が上書きした場合はリトライ
      if (Math.abs(el.scrollTop - y) > 2 && tries < 20) {
        requestAnimationFrame(attempt);
      }
    };
    requestAnimationFrame(attempt);
  }, [url, isItemList]);

  return null;
}
