"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * カバレッジ・アイテム一覧のスクロール位置記憶（(main) レイアウトに常駐）。
 *
 * このアプリのスクロールは window ではなく、レイアウトの `<main class="overflow-auto">`
 * の内部スクロールである。`<main>` はナビゲーションを跨いで生存するため、アセットページ
 * （?hl=nina の言及への自動スクロール）で下がった scrollTop が、戻ったあとの
 * アイテム一覧にそのまま持ち越される（ブラウザ/App Router の復元は window のみ）。
 *
 * 実装ノート:
 * - popstate フラグを React ref に持つ方式は、Suspense 配下でナビゲーション中に
 *   コンポーネントが再マウントされるとフラグが消えて復元がスキップされる。
 *   そのため「直前の pathname がアセット詳細だったか」を**モジュール変数**
 *   （再マウントしても生存）で判定する。アイテム一覧に /assets/ から戻る経路は
 *   実質ブラウザバックのみなので、popstate 判定は不要。
 * - リストの再描画・遅延読み込みで高さが変動し位置がずれるため、復元は
 *   一定時間（~800ms）再アサートする。ユーザーが自分でスクロール操作したら即中止。
 */

// 直前に表示していた pathname（モジュールスコープ = 再マウント耐性）
let lastPathname: string | null = null;

const isItemListPath = (p: string) => /^\/coverage\/[^/]+/.test(p);
const keyFor = (url: string) => `cov-scroll:${url}`;

export function CoverageScrollMemory() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const url = `${pathname}?${searchParams.toString()}`;
  const isItemList = isItemListPath(pathname);

  // --- 復元（保存リスナーより先に定義 = 先に実行。保存値を先に読み切る） ---
  useEffect(() => {
    const prev = lastPathname;
    lastPathname = pathname;
    if (!isItemList) return;
    if (!prev || !prev.startsWith("/assets/")) return; // アセット詳細からの戻りのみ

    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(keyFor(url));
    } catch {
      /* noop */
    }
    if (raw == null) return;
    const y = parseInt(raw, 10);
    if (Number.isNaN(y) || y < 0) return;

    const el = document.querySelector("main");
    if (!el) return;

    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    // ユーザー自身の操作が始まったら再アサートをやめる
    el.addEventListener("wheel", cancel, { passive: true, once: true });
    el.addEventListener("touchstart", cancel, { passive: true, once: true });
    window.addEventListener("keydown", cancel, { once: true });

    const assert = () => {
      if (!cancelled) el.scrollTop = y;
    };
    // 直後の数フレーム＋高さ変動の収束を待つ時間差の再アサート
    const rafIds: number[] = [];
    let chained = 0;
    const rafLoop = () => {
      assert();
      if (!cancelled && chained++ < 8) rafIds.push(requestAnimationFrame(rafLoop));
    };
    rafIds.push(requestAnimationFrame(rafLoop));
    const timers = [150, 350, 800].map((ms) => setTimeout(assert, ms));

    return () => {
      cancelled = true;
      rafIds.forEach(cancelAnimationFrame);
      timers.forEach(clearTimeout);
      el.removeEventListener("wheel", cancel);
      el.removeEventListener("touchstart", cancel);
      window.removeEventListener("keydown", cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // --- 滞在中の常時記録（throttle 150ms） ---
  useEffect(() => {
    if (!isItemList) return;
    const el = document.querySelector("main");
    if (!el) return;
    const key = keyFor(url);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        try {
          sessionStorage.setItem(key, String(el.scrollTop));
        } catch {
          /* noop */
        }
      }, 150);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [url, isItemList]);

  return null;
}
