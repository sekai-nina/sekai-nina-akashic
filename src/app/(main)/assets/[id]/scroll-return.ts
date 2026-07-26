"use client";

import { useEffect, type RefObject } from "react";

const STORAGE_PREFIX = "asset-scroll:";
/** 画像の読み込みでレイアウトが動くのを待つ上限 */
const RESTORE_TIMEOUT_MS = 3000;

interface Anchor {
  /** クリックした本文中画像のアセットID */
  imageAssetId: string;
  /** クリック時、その画像がスクロール領域の上端から何px下にあったか */
  offsetTop: number;
}

/**
 * StrictMode では effect が「実行 → 破棄 → 再実行」されるため、1回目で
 * sessionStorage を消してしまうと2回目に復元先が分からなくなる。いったん
 * モジュール側に移してから使い切る。
 */
const pendingAnchors = new Map<string, Anchor>();

/**
 * スクロールしているのは window ではなくレイアウトの <main>（overflow-auto）なので、
 * 対象の要素から遡って実際のスクロール親を探す。
 */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * 本文中の画像から別アセットへ飛ぶ直前に、戻り先を覚えておく。
 *
 * スクロール量（px）ではなく「クリックした画像がどこにあったか」で覚える。
 * 戻った直後のページは画像が未読み込みで実際より短く、px で覚えても
 * 後から画像が読み込まれるたびに位置がずれていくため。
 */
export function rememberScroll(assetId: string, imageAssetId: string, imageEl: HTMLElement) {
  const scroller = findScrollParent(imageEl);
  if (!scroller) return;
  const offsetTop = imageEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  window.sessionStorage.setItem(
    STORAGE_PREFIX + assetId,
    JSON.stringify({ imageAssetId, offsetTop } satisfies Anchor)
  );
}

function takePendingAnchor(assetId: string): Anchor | undefined {
  const key = STORAGE_PREFIX + assetId;
  const saved = window.sessionStorage.getItem(key);
  if (saved != null) {
    window.sessionStorage.removeItem(key);
    try {
      const parsed = JSON.parse(saved) as Anchor;
      if (typeof parsed?.imageAssetId === "string") pendingAnchors.set(assetId, parsed);
    } catch {
      // 壊れた値は無視する
    }
  }
  return pendingAnchors.get(assetId);
}

/**
 * rememberScroll() で覚えた画像を、離れたときと同じ位置に戻す。
 *
 * 1回セットするだけでは足りない:
 * - 画像が読み込まれるまでページが短く、そこまでスクロールできない
 * - 読み込みが進むたびに上の画像の分だけ下へ押し出される
 * - 復元した直後に Next.js 側のスクロール処理が上端付近へ戻すことがある
 *
 * そこで一定時間、毎フレーム「その画像が指定の位置に来るように」補正し続ける。
 * ユーザーが自分でスクロールしたら邪魔になるのでその時点で打ち切る。
 */
export function useRestoreScroll(assetId: string, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const anchor = takePendingAnchor(assetId);
    if (!anchor) return;

    const container = ref.current;
    const scroller = findScrollParent(container);
    if (!container || !scroller) return;

    let frame = 0;
    let cancelled = false;
    const deadline = Date.now() + RESTORE_TIMEOUT_MS;

    /** ループを止めるだけ。StrictMode の破棄でも呼ばれるので復元先は捨てない。 */
    function cancel() {
      cancelled = true;
      cancelAnimationFrame(frame);
    }

    /** 復元を完了・中止した。もう戻さない。 */
    function finish() {
      cancel();
      pendingAnchors.delete(assetId);
    }

    function attempt() {
      if (cancelled) return;
      const target = container!.querySelector<HTMLElement>(
        `a[href="/assets/${anchor!.imageAssetId}"]`
      );
      if (target) {
        const current =
          target.getBoundingClientRect().top - scroller!.getBoundingClientRect().top;
        const delta = current - anchor!.offsetTop;
        if (Math.abs(delta) > 1) scroller!.scrollTop += delta;
      }
      if (Date.now() > deadline) {
        finish();
        return;
      }
      frame = requestAnimationFrame(attempt);
    }

    const userEvents = ["wheel", "touchstart", "keydown", "mousedown"] as const;
    for (const type of userEvents) {
      window.addEventListener(type, finish, { passive: true });
    }

    frame = requestAnimationFrame(attempt);
    return () => {
      cancel();
      for (const type of userEvents) window.removeEventListener(type, finish);
    };
  }, [assetId, ref]);
}
